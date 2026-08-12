# Adaptive Provider Queue for OMP

OMP 原生 provider extension。正常状态不设置固定并发上限；上游返回可重试的限流或传输错误后，默认由每个请求独立执行分段重试。跨 OMP 进程的 FIFO 队列和共享恢复预算是显式可选功能，默认关闭。

## Behavior

```text
OMP request
  -> send immediately when no backlog exists
  -> managed provider failure before text/tool/image output
  -> use one request-local 50-retry budget with staged backoff
  -> forward the final provider error to OMP fallback after exhaustion

Optional shared mode
  -> join a credential-scoped FIFO lane after a retryable failure
  -> share one cross-process 50-retry campaign
  -> let only the FIFO head probe recovery
  -> clear shared state after recovery is observed
```

Concurrency/rate-limit errors, authentication or permission failures,
quota/credits/billing exhaustion, explicit model/capacity/route unavailability,
temporary upstream `502/503/504` responses and transient transport failures such
as `stream_read_error`, timeouts, reset sockets, incomplete streams or failed
fetches consume the same request-local retry counter and use the same pacing.
Thinking-only output may be retried without duplicating the
thinking block; once text, a tool call or an image has been emitted, the stream
is never replayed.

Unless a wall-clock mode says otherwise, a 50-retry budget means one initial
request plus at most 50 retries: 51 provider requests in the worst case.

Cross-window sharing can be changed for the current session:

```text
/adaptive-share status
/adaptive-share on
/adaptive-share off
/adaptive-share toggle
```

New sessions default to `off`. In this isolated mode, each request owns its own
counter and delay schedule and never reads or writes queue tickets, retry state
or recovery markers. `on` restores the credential-scoped FIFO and shared
campaign behavior. The choice is stored in session history, restored by
`/resume`, and inherited by subagents through the root session lineage. It is
captured when a request starts, so changing it does not migrate an already
running retry campaign. Shared state left by another or older window is ignored
while sharing is off and is not deleted; it can be observed again if sharing is
turned on before that state expires.

Generic HTTP `502/503/504` handling can be changed for the current session:

```text
/adaptive-5xx status
/adaptive-5xx list
/adaptive-5xx retry
/adaptive-5xx retry-stop
/adaptive-5xx retry-5m
/adaptive-5xx fallback
/adaptive-5xx toggle
```

New sessions default to `retry`. `retry-stop` uses the same staged 50-retry
budget for every provider failure managed by this extension, but ends the
current turn instead of entering OMP fallback when that budget is exhausted.
It is request-local and forces shared retry off so another window cannot shorten
or prolong its budget. This includes authentication, quota, billing and explicit
model-unavailable failures. `retry-5m` keeps retrying the current provider
with the staged backoff for at most five wall-clock minutes after the first
generic `502/503/504`; recovery stays on the same provider, while expiry forwards
the last error to OMP fallback. A retry still in flight at the deadline is aborted;
once text, a tool call or an image starts, the deadline is removed so a healthy
long response can finish. Pressing Esc during that window cancels the turn without
starting fallback, including a deadline race. The fixed window is request-local, so selecting it
turns shared retry off for the session and `/adaptive-share on` is rejected until
another 5xx mode is selected. `fallback` forwards a generic `502/503/504` after
the first failed request so OMP can traverse its model fallback chain. `list`
shows all modes and marks the active one. `toggle` cycles in this order:
`retry -> retry-stop -> retry-5m -> fallback -> retry`.
The choice is stored in the session, restored by `/resume`, and inherited by a
fork whose active branch contains the policy entry. The status bar displays
both choices, for example `5xx: retry 50x -> fallback | shared: off`, so the effective
behavior remains visible after the command notification closes. Subagents created by the session
use that root session's current choice, including detached and nested subagents
that outlive a later root-session switch. Policy lookup is keyed by request
session and stable artifact lineage, so a subagent reloading the provider cannot
replace or migrate the root policy.

The command name is retained for session-history compatibility, but its final
action now applies to every managed provider failure. `fallback` and `retry-5m`
only specialize ordinary `502/503/504`; authentication, quota/billing,
model-unavailable, overload, rate-limit and transport failures keep the
50-retry campaign. `retry-stop` changes what happens after that campaign is
exhausted.

The ordinary-5xx part of the switch is intentionally narrow. Explicit
concurrency/rate-limit, authentication/permission, quota/billing,
model/capacity/route unavailable or `server_is_overloaded` failures, even when
accompanied by `502/503/504`, plus status-less transport failures and
`stream_read_error`, still use the 50-retry campaign in every mode. It is local
in `retry-stop`, local or shared according to `/adaptive-share` in other modes.
Their 50-retry counter is separate from the five-minute generic-5xx window, so
switching error classes does not make either policy expire early.

The policy is evaluated independently for each provider attempt in OMP's fallback
chain. If a fallback provider also returns an ordinary `502/503/504`, it starts its
own five-minute window. Other managed failures use that provider request's
50-retry campaign instead of the five-minute window.

Retry pacing is deliberately staged so a temporary provider limit does not
turn into a rapid retry storm:

| Retry number | Delay policy |
|---|---|
| 1-10 | Existing exponential backoff (500 ms base, 30 s first-stage cap) |
| 11-20 | 1 minute |
| 21-30 | 2 minutes |
| 31-40 | 3 minutes |
| 41-50 | 5 minutes maximum |
| After 50 in `retry` | Forward the last retryable error to OMP fallback |
| After 50 in `retry-stop` | End the current turn without OMP fallback |

A small positive jitter remains on staged delays to avoid synchronized retries,
but no wait can exceed five minutes. In default isolated mode, cancellation only
ends that request's wait and no state survives it. In optional shared mode, the
queue head is the only recovery probe; other OMP windows wait instead of
starting their own campaigns. Text, a tool call, an image or successful
completion clears shared state. Exhaustion or a terminal pre-content probe
failure remains cached for five minutes, so queued and newly arriving shared
requests reach OMP fallback without contacting upstream. The next live queue
head can claim an active campaign without resetting its count or retry deadline.

Interactive root sessions expose retry activity through one replaceable status
slot rather than notifications that accumulate in the transcript. A typical
status is:

```text
TokenKing retry 2/50 [#-----------] transport
```

During `retry-5m`, the same slot becomes a time-based progress bar, for example
`AI Input retry 4 [#####-------] 5xx fallback in 3m12s`. It refreshes in place
once per second during longer backoffs and in-flight probes and does not add transcript messages or
consume model tokens.

The bar and exact counter follow the request-local budget. Shared mode adds a
queue position such as `q1/2`, meaning this window is first among two live
tickets. The same status key is updated as the attempt or queue position changes and is cleared after substantive output,
successful completion, cancellation or terminal failure. Detached and nested
subagents do not overwrite the active root window's progress status. Requests
without an explicit session ID are treated as background work and cannot write
to the interactive slot.

Set OMP's global `retry.maxRetries` to `0`, as shown in
[`examples/config.yml`](examples/config.yml). The extension owns managed
provider-failure retries; disabling the outer retry loop prevents a fallback model's
502/503 response from starting a second retry budget. `retry.modelFallback`
remains enabled, so non-retryable failures can still traverse the configured
fallback chain once.

The current operational policy, exact failure-domain boundaries, fallback
cooldown behavior and diagnostic commands are recorded in
[`RETRY-STRATEGY.md`](RETRY-STRATEGY.md).

| Failure | Action |
|---|---|
| Concurrency/rate-limit 429 before text/tool/image | Retry with the selected local/shared 50-retry budget |
| Generic upstream `502/503/504` in the default session mode | Retry with the selected local/shared 50-retry budget |
| Any managed provider failure after `/adaptive-5xx retry-stop` | Retry locally up to 50 times, then stop this turn without OMP fallback |
| Generic upstream `502/503/504` after `/adaptive-5xx retry-5m` | Retry the current provider for at most five minutes, then forward the last error to OMP fallback |
| Generic upstream `502/503/504` after `/adaptive-5xx fallback` | Forward to OMP fallback after one request |
| Explicit server overload | Retry with the 50-retry budget; `retry-stop` ends instead of fallback on exhaustion |
| Stream/connection transport error before text/tool/image | Retry with the 50-retry budget; `retry-stop` ends instead of fallback on exhaustion |
| 429 quota, credits or billing exhausted | Retry with the 50-retry budget |
| 401/402/403 authentication, payment or permission failure | Retry with the 50-retry budget |
| Explicit model, capacity or route unavailable | Retry with the 50-retry budget |
| Error after text, tool call or image output | Forward unchanged; never replay partial output |
| 50th isolated retry still fails | Forward the final provider error to OMP fallback |
| 50th shared retry still fails | Forward to OMP fallback and cache lane exhaustion for five minutes |
| Shared request while lane exhaustion is cached | Forward to OMP fallback without contacting upstream |
| 50th retry in `retry-stop` still fails | Emit a terminal aborted turn; do not enter OMP fallback |

## Registered providers

| Provider | Endpoint | Model | Credential source |
|---|---|---|---|
| `aiinput-queued` | `https://ai.input.im/v1` | `gpt-5.6-sol` | `AIINPUT_API_KEY` |
| `aiinput-overseas-queued` | `https://input.codes/v1` | `gpt-5.6-sol` | `AIINPUT_API_KEY` |
| `aiinput2-overseas-queued` | `https://input.codes/v1` | `gpt-5.6-sol` | `AIINPUT2_API_KEY` |
| `tokenking-queued` | `https://api.tokenskingdom.com/v1` | `gpt-5.6-sol` | `TOKENKING_API_KEY` |
| `tokenking-grok-queued` | `https://api.tokenskingdom.com/v1` | `grok-4.5` | `TOKENKING_GROK_API_KEY` |
| `kimi-code-queued` | `https://api.kimi.com/coding/v1` | 7 models: K3, K3-256k, K2.7 Coding, K2.7 Coding Highspeed, K2, K2 Turbo and K2.5 | Stored `kimi-code` login via `!omp token kimi-code --raw` |

`kimi-code-queued` reuses the credential already stored by `omp login kimi-code`.
OMP resolves it through the command-backed provider value
`!omp token kimi-code --raw`; no Kimi key is copied into this repository or
required in `.env`. Command-backed values are cached for the lifetime of an OMP
process, so restart existing OMP windows after logging in again. No API key is
stored in queue metadata. The lane identity hashes endpoint origin and
credential scope with SHA-256.

The seven queued model entries are a static mirror of OMP `17.2.12`'s current
Kimi Code catalog. The built-in `kimi-code` provider can refresh its model list
dynamically; newly added or changed Kimi models require an explicit update here
before they appear under `kimi-code-queued`.

## Install

Choose exactly one installation target: the bundle root or this subpackage. OMP treats them as different plugin identities even though both load this same extension, so installing both registers the providers twice.

From the bundle repository root, link the whole bundle using either local-path spelling:

```bash
# Development: load this checkout directly
omp plugin link .

# In OMP 17.2.2 this is also a symlink
omp plugin install .
```

Moving or deleting the checkout breaks either local-path installation. To install only this package, use `./omp/adaptive-provider-queue` instead, after uninstalling the root bundle. GitHub installs must target the repository root; OMP does not support a package subdirectory selector for Git sources.

```bash
# Before switching from the bundle root to this subpackage
omp plugin uninstall pi-omp-plugin-bundle

# Before switching back to the bundle root
omp plugin uninstall omp-adaptive-provider-queue
```

For a non-mutating preview use `omp plugin install PATH --dry-run`. In OMP 17.2.2, `omp plugin link PATH --dry-run` still creates the link.

Set credentials in OMP's private environment file:

```dotenv
AIINPUT_API_KEY=your-key
AIINPUT2_API_KEY=your-second-account-key
TOKENKING_API_KEY=your-key
TOKENKING_GROK_API_KEY=your-key
```

Then merge the relevant fields from [`examples/config.yml`](examples/config.yml) into `~/.omp/agent/config.yml` and start a new OMP session.

### Existing manual extension

Do not load this package alongside another copy under `~/.omp/agent/extensions/adaptive-provider-queue`. Both copies register the same provider names. Keep the current manual extension active until the linked package has passed validation, then switch sources in one operation.

## Credential migration helper

The optional helper replaces inline credentials for the existing AI Input account 1,
AI Input account 2 and `tokenking-grok` entries in `models.yml` with
environment-variable references and writes the recovered values to `.env` using
mode `0600`:

```bash
ruby scripts/migrate-credentials.rb ~/.omp/agent/models.yml ~/.omp/agent/.env
```

Back up both files first. The helper does not print credential values, but it mutates both targets atomically.

## Development

```bash
npm test
npm run pack:check
```

The tests cover error classification, session policy restoration, generic 5xx
and shared-recovery mode switching, fully isolated local retries, retry progress lifecycle, reverse cross-process clocks, legacy
ticket compatibility, retry-after parsing, Responses compatibility, Kimi
credential and model adaptation, cancellation, stale ticket cleanup, replay
boundaries, shared retry counters, exhaustion propagation, success clearing
and owner takeover between separate processes.

## Compatibility

- Verified with OMP `17.2.12`. The queued Kimi transport relies on that
  version's `streamKimi` export and model contract; older OMP releases are not
  covered by the current verification.
- Uses OMP's `@oh-my-pi/pi-ai` and `@oh-my-pi/pi-coding-agent` runtime modules.
- The current source is OMP-native and is not declared compatible with standalone Pi.

## Runtime state

When `/adaptive-share on` is active, tickets default to
`~/.omp/run/adaptive-provider-queue/`. Default isolated requests do not create,
read or update this runtime state. Shared lane directories are
created with `0700`; ticket files use `0600`. Each endpoint + credential lane
may also contain one `retry-state.json`, written as a mode-`0600` temporary file
and atomically replaced. It records only active/exhausted status, shared attempt
count, ticket owner, next retry, expiry, last failure kind and optional HTTP
status. Raw credentials
are never stored. Dead-process and stale tickets are removed during queue scans;
the next FIFO head claims any still-active state.

Sortable ticket and retry-state-lock names receive a lane-wide order while the
publication lock is held. They do not compare process-relative monotonic clocks,
which are not portable ordering keys across separate Bun processes. Recovery
markers likewise use an opaque shared generation rather than cross-process
clock comparison. When a ticket reaches the head, it receives a stable front
order under that same publication lock; this keeps a still-running older OMP
process from displacing the active owner during a rolling reload. Recovery
markers retain a version-1-compatible envelope so both old and new readers can
observe success. Strict FIFO between all waiters requires `/reload` in every
OMP window that still has a pre-0.4.2 extension instance in memory. Every open
OMP window must run `/reload` after an extension update; closing Terminal is not
required.

## License

Private personal package (`UNLICENSED`). Select an explicit license before public distribution.
