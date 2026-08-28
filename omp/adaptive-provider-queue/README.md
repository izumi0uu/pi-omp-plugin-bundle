# Universal Adaptive Provider Retry for OMP

OMP-native extension that applies adaptive retry behavior to every model in the
OMP model registry. Provider and model selectors stay unchanged: select
`aiinput/gpt-5.6-sol`, `tokenking/gpt-5.6-sol`, `kimi-code/k3`, or any other
normal OMP model. Separate `*-queued` providers are no longer registered or
required.

## How it works

At session start and before provider dispatch, the extension replaces each
registered model's internal API transport with one universal retry transport.
When a request starts, that transport restores the model's original API and
calls OMP's normal `streamSimple` implementation through the adaptive retry
wrapper. This preserves the original provider, credential source, model
metadata, OAuth behavior, and visible selector. Only the request-local AI Input
model copy receives a base URL selected from the allowlist below.

```text
OMP model request
  -> universal retry transport
  -> original model transport with OMP inner retries disabled
  -> AI Input requests: latency/jitter endpoint selection per attempt
  -> retry classifies failures, waits, excludes an endpoint when appropriate
  -> return success, stop the turn, or hand the final error to OMP fallback
```

The wrapper covers model requests dispatched through `streamSimple`. It does
not wrap independent HTTP traffic from tools or other subsystems, including
`web_search`, image-generation-specific transports, MCP servers, provider
login, token refresh, or other authentication calls.

For custom `anthropic-messages` models, OMP treats `anthropic-beta` as a
protected header and may omit a value declared in `models.yml`. The wrapper
keeps the value in OMP's `betas` request option and uses a request-local `fetch`
wrapper to merge it into the final outgoing headers. This final-header bridge
also works on OMP versions that discard `betas` during option normalization.
Existing beta values are preserved and deduplicated; global `fetch`, credentials,
and non-Anthropic transports are unchanged.

AgentRouter accepts OMP's Codex request identity but exposes GPT Responses at
`/v1/responses` rather than OMP's Codex-specific `/codex/responses` path. For an
`agentrouter`, `agentrouter-2`, or `agentrouter-3` GPT model declared with
`api: openai-codex-responses`, the wrapper rewrites only that final request path
on `https://agentrouter.org` and supplies the client identity required by the
gateway. Codex headers, body, reasoning effort, credentials, proxy selection,
retry signals, and SSE parsing remain owned by OMP. Other AgentRouter routes and
all other providers pass through unchanged; remote Codex compaction should
remain disabled because AgentRouter does not expose OMP's compaction endpoint.

## Default policy

New sessions default to `retry-stop` and isolated recovery:

- One initial provider request plus at most 50 retries.
- No fixed concurrency limit while the provider is healthy.
- No cross-window queue or shared retry state by default.
- Managed failures exhaust the local retry budget, then end the current turn
  without switching to OMP fallback.
- OMP's outer retry loop should remain disabled with `retry.maxRetries: 0`.

Managed pre-content failures include concurrency and rate limits, explicit
server overload, generic `502/503/504/524`, transient connection and stream errors,
`401/402/403`, revoked or invalid credentials, quota/billing exhaustion, and
explicit model/capacity/route unavailability. Ordinary unclassified request
errors pass through to OMP. Once text, a tool call, or an image has been
emitted, the extension never replays that partial response.

AgentRouter has one deliberate exception to the default local retry policy:
when an `agentrouter`, `agentrouter-2`, or `agentrouter-3` request contains an
explicit quota/billing exhaustion signal such as `insufficient_user_quota`, the
wrapper releases its local retry ticket immediately and forwards that error to
OMP. OMP then follows the configured provider fallback chain. Generic `401`,
`403`, revoked credentials, and ordinary rate limits do not match this shortcut;
they retain the normal retry behavior.

### Subagent error handoff

Subagents load the same extension by path when OMP creates their session, so
their provider requests use this retry wrapper and inherit the root session's
retry policy through session lineage. On `retry-stop` exhaustion, the wrapper
emits a terminal `error` (not a synthetic cancellation) with the stable
`ADAPTIVE_RETRY_EXHAUSTED` marker. The OMP Abort classification bit is attached
only to suppress OMP's second retry/fallback pass; the task executor can still
copy the terminal `errorMessage` into the parent task result.

The child output also contains a bounded, credential-redacted report:

```text
ADAPTIVE_RETRY_EXHAUSTED
provider: kimi-code
model: k3
retries: 50/50
fallback: suppressed
status: 503
last_error: Service temporarily unavailable
```

The parent therefore receives both a failed task result and the useful provider
diagnostic. Successful child yields and ordinary OMP task events are unchanged.

## AI Input Endpoint Router

The `aiinput` provider has one logical account and three allowlisted base URLs:

```text
https://ai.input.im/v1
https://eo.input.codes/v1
https://input.codes/v1
```

The router only measures network quality. Every 30 seconds it probes each URL's
`/models` endpoint in parallel, keeps the latest eight latency samples, and
calculates `score = latency EWMA + 1.5 * jitter EWMA`. Every completed,
non-redirect HTTP response counts as a latency sample regardless of status. A
network failure, timeout, or rejected redirect has no score for that round;
none of these create error state inside the router. Redirects are not followed,
so the probe cannot forward the API key to another host. The first automatic
request waits for an initial probe, while later attempts use cached scores. A
challenger must be at least 20% better for two consecutive rounds before the
default route changes.

Probes use OMP's provider-aware proxy resolution, including
`PI_PROXY_AIINPUT`, `PI_PROXY`, standard protocol proxies, and `NO_PROXY`.
Concurrent requests can share one probe round while retaining independent Esc
cancellation. A local lock, permission, or state-file failure is telemetry loss
only: routing falls open to the cached or configured AI Input URL and does not
send the model request into fallback.

Universal Retry owns all error semantics. For a transport error or generic
`502/503/504/524`, it temporarily excludes the URL for the next attempt; `429`,
authentication, quota, and model errors do not cause a route change. Once all
three URLs have been tried in the current request, the exclusion set resets.
The router never retries a stream or classifies a provider response.

Automatic measurements and the selected automatic route are shared under
`~/.omp/run/adaptive-provider-queue/` and never contain the API key. Manual
pins are stored in the current OMP session, so another window remains
independent. Inspect or control the current session with:

```text
/aiinput-route status
/aiinput-route refresh
/aiinput-route auto
/aiinput-route pin <ai|eo|input>
/aiinput-route pin <ai|eo|input> <duration>
```

The aliases map to `ai.input.im`, `eo.input.codes`, and `input.codes`. Duration
accepts `s`, `m`, `h`, or `d`, for example `30m` or `2h`; omitting it pins until
this session runs `auto`. A pin survives reload/resume of this session but is
not inherited by another top-level OMP session or a fork with a new session ID,
even when that fork copies the original branch entries. Its subagents use the
same route because they belong to the same session tree. The policy is attached
to the whole session rather than one history branch, so tree navigation does not
silently clear it. OMP's rotating provider IDs from `/fresh`, `/clear`, Advisor,
`/btw`, and `/tan` are resolved back to that owning session.

While pinned, probes keep updating the shared measurements and automatic
candidate, but neither automatic selection nor a Retry exclusion can override
the pin. Retry still decides waits, retry exhaustion, stop, and provider
fallback. `auto` takes effect immediately from cached measurements and does not
wait for a new probe.

Retry pacing:

| Retry | Delay |
|---|---|
| 1-10 | Exponential backoff from 500 ms, capped at 30 seconds |
| 11-20 | 1 minute |
| 21-30 | 2 minutes |
| 31-40 | 3 minutes |
| 41-50 | 5 minutes |

A small positive jitter is added without exceeding the five-minute cap. Esc
cancels the active wait or request.

## Session commands

Use `/adaptive-5xx` to inspect or change what happens around managed failures:

```text
/adaptive-5xx status
/adaptive-5xx list
/adaptive-5xx retry
/adaptive-5xx retry-stop
/adaptive-5xx retry-5m
/adaptive-5xx fallback
/adaptive-5xx toggle
```

| Mode | Behavior |
|---|---|
| `retry-stop` | Default. Retry managed failures locally up to 50 times, then stop the turn without OMP fallback. |
| `retry` | Retry managed failures up to 50 times, then forward the final error to OMP fallback. |
| `retry-5m` | Retry generic `502/503/504/524` locally for at most five minutes, then use fallback; other managed failures retain the 50-retry policy. |
| `fallback` | Send generic `502/503/504/524` directly to fallback; other managed failures retain the 50-retry policy. |

The command name is retained for history compatibility, although the final
stop-versus-fallback decision now applies to all managed failures. The selected
mode is saved in session history, restored by `/resume`, and inherited by
subagents through session lineage.

Cross-window FIFO recovery remains optional:

```text
/adaptive-share status
/adaptive-share on
/adaptive-share off
/adaptive-share toggle
```

`off` is the default. `on` creates one provider-account-scoped FIFO lane across
OMP processes, shares a recovery budget, and lets only the queue head probe the
provider. AI Input's three URLs share one lane for the same credential; other
providers retain endpoint-and-credential lane identity. `retry-stop` and
`retry-5m` force isolated recovery, so shared mode cannot be enabled while
either is active.

The status bar shows the active policy and retry progress without adding
transcript messages, for example:

```text
5xx: retry 50x -> stop | shared: off
AI Input retry 2/50 [#-----------] transport
```

## Configuration

Use normal provider selectors in roles and fallback chains:

```yaml
modelRoles:
  default: aiinput/gpt-5.6-sol:max
  research: tokenking-grok/grok-4.6:high

retry:
  maxRetries: 0
  modelFallback: true
  fallbackRevertPolicy: cooldown-expiry
  fallbackChains:
    aiinput/*:
      - tokenking/gpt-5.6-sol:max
    kimi-code/*:
      - aiinput/gpt-5.6-sol:max
    tokenking-grok/*:
      - aiinput/gpt-5.6-sol:max
    agentrouter/*:
      - agentrouter-2/*
      - agentrouter-3/*
    agentrouter-2/*:
      - agentrouter-3/*
    justworker/*:
      - justworker-2/*
      - justworker-3/*
    justworker-2/*:
      - justworker-3/*
```

With this chain, a failing `agentrouter/gpt-5.6-sol` keeps the model id while
moving through `agentrouter-2/gpt-5.6-sol` and then
`agentrouter-3/gpt-5.6-sol`. There is intentionally no reverse edge from
`agentrouter-3` back to `agentrouter`, so a failed account cannot create a
fallback loop.

The same account-fallback pattern works for independent JustWorker
credentials: `justworker/*` -> `justworker-2/*` -> `justworker-3/*`. Explicit
quota or billing exhaustion on these aliases is forwarded to OMP's fallback
chain immediately; ordinary transient failures continue to use the active
retry policy.

The extension does not define provider endpoints, API keys, or model entries.
Keep those in OMP's built-in login store or `~/.omp/agent/models.yml` as usual.

An AgentRouter provider can mix its native Anthropic models with the Codex
transport used for GPT:

```yaml
providers:
  agentrouter:
    baseUrl: https://agentrouter.org
    apiKey: AGENTROUTER_API_KEY
    api: anthropic-messages
    authHeader: true
    disableStrictTools: true
    models:
      - id: claude-opus-5
        api: anthropic-messages
      - id: gpt-5.6-sol
        api: openai-codex-responses
        reasoning: true
        remoteCompaction:
          enabled: false
```

## AgentRouter 长任务与 socket 断流

AgentRouter 是远端网关。长时间保持一个 Anthropic/Codex SSE 请求、在请求中等待
subagent，或反复恢复一个很大的 session 时，网关可能在已经返回部分内容后关闭
socket。常见错误包括：

```text
The socket connection was closed unexpectedly
Anthropic stream envelope error: stream ended before message_stop
Codex stream ended before terminal completion event
```

这类错误首先要区分“新窗口”和“新 session”：

- `omp --resume <id>` 只是换了一个终端进程，仍会重新加载同一个历史、上下文和
  session 级策略；窗口变新不会清空长上下文或遗留的 subagent 等待。
- 真正的新 session 要直接从目标工作区启动 `omp`，不要带旧的 `--resume` ID。

```bash
cd /path/to/project
omp --model agentrouter-2/claude-opus-5 --thinking max
```

恢复时建议把当前任务压缩成一段短 handoff，再把长任务拆成几个独立 session；
不要让一个 session 长时间等待多个 subagent 后继续在同一条远端流上工作。

重试边界也很重要。扩展只会对“尚未产生实质输出”的可管理错误进行本地重试。
一旦已经发出文本、tool call 或图片，整轮重放会有重复写文件、重复执行工具或
重复提交外部操作的风险，因此扩展会停止当前轮次并保留原错误。这时状态栏上的
`5xx: retry 50x -> stop` 只是当前策略，不代表这次断流已经执行了 50 次重试。

遇到断流时可按下面顺序判断：

1. 查看当前策略：`/adaptive-5xx status`。
2. 查看当前 OMP 进程日志，确认 provider、model、`contentBlocks` 和
   `hasText`：

   ```bash
   rg -n -C 3 'socket connection|stream envelope|agent turn ended|adaptive provider' \
     ~/.omp/logs/omp.*.log
   ```

3. 如果日志显示已经有文本或工具输出，直接新建 session 继续，不要反复
   `--resume` 同一个大 session。
4. 如果一个全新的短请求也失败，再检查 AgentRouter 网关状态、凭据和本机网络；
   插件无法对已有副作用的半截流做无损重放。

## Installation

From this repository root, choose one installation source:

```bash
omp plugin link .
```

Or link only this package after uninstalling any root-bundle copy:

```bash
omp plugin uninstall pi-omp-plugin-bundle
omp plugin link ./omp/adaptive-provider-queue
```

Do not load both a plugin-manager copy and a manual copy under
`~/.omp/agent/extensions/adaptive-provider-queue`; duplicate extension loading
can register commands and transports twice. After updating the extension, run
`/reload` in every open OMP window or restart OMP.

## Removing custom providers or models

The extension includes a guarded editor for entries in
`~/.omp/agent/models.yml`:

```text
/provider-remove list
/provider-remove aiinput/gpt-5.6-sol --dry-run
/provider-remove aiinput/gpt-5.6-sol
/provider-remove justworker --force --yes
```

With no arguments, `/provider-remove` opens an interactive OMP selector: choose
a provider, choose `Delete one model` or `Delete entire provider`, choose the
model when needed, and confirm. This uses the same extension select/confirm UI
surface as other OMP commands. OMP does not currently expose an extension hook
for adding a button inside the built-in `/model` menu, so the selector is a
separate command rather than a patch to OMP's internal menu.

`/provider-delete` is an alias. Use either `provider/model` or the explicit
`provider <name>` / `model <provider>/<model>` forms. Interactive deletion asks
for confirmation; headless use requires `--yes`. `--dry-run` never writes. A
whole-provider deletion is blocked when `config.yml` contains role or fallback
references unless `--force` is supplied. Every real edit creates a
timestamped `models.yml.bak-remove-*` backup and atomically replaces the file.
Credentials in `.env` and OMP's login store are intentionally untouched.
Restart OMP or run `/reload` after a successful edit so the in-memory registry
is rebuilt. References are reported but never rewritten automatically.

## Verification

```bash
npm test
omp config get retry.maxRetries
omp config get retry.fallbackChains --json
omp models --json
```

Expected results:

- Tests pass.
- `retry.maxRetries` is `0`.
- Roles and fallback chains contain only normal provider selectors.
- `omp models --json` contains no providers ending in `-queued`.
- The active registry contains one `aiinput` provider and no `aiinput-overseas` alias.
- `/adaptive-5xx status` reports `retry-stop` for a new session.

## Compatibility and state

Verified with OMP `18.0.0`. The implementation depends on OMP exposing mutable
model registry entries and routing their `api` value through `streamSimple`.
Future OMP releases that freeze or copy registry entries require revalidation.
The package is OMP-native and is not declared compatible with standalone Pi.

When `/adaptive-share on` is active, coordination state is stored under
`~/.omp/run/adaptive-provider-queue/` with credential-free lane identities.
Directories use mode `0700`; state files use `0600`. Default isolated requests
do not read or write this shared runtime state.

Detailed operational behavior and fallback boundaries are recorded in
[`RETRY-STRATEGY.md`](RETRY-STRATEGY.md).

## License

Private personal package (`UNLICENSED`). Select an explicit license before
public distribution.
