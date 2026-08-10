# Adaptive Provider Queue for OMP

OMP 原生 provider extension。正常状态不设置固定并发上限；上游返回可重试的限流或传输错误后，才为同一 endpoint + API key 建立跨 OMP 进程共享的 FIFO 队列。

## Behavior

```text
OMP request
  -> send immediately when no backlog exists
  -> retryable rate-limit or transport failure before text/tool/image output
  -> join credential-scoped FIFO lane
  -> share one 50-attempt budget with staged backoff
  -> release lane after the whole stream terminates
```

Concurrency/rate-limit errors, explicit temporary server overloads and transient
transport failures such as `stream_read_error`, timeouts, reset sockets,
incomplete streams or failed fetches consume the same retry counter and use the
same pacing. Thinking-only output may be retried without duplicating the
thinking block; once text, a tool call or an image has been emitted, the stream
is never replayed.

Retry pacing is deliberately staged so a temporary provider limit does not
turn into a rapid retry storm:

| Retry number | Delay policy |
|---|---|
| 1-10 | Existing exponential backoff (500 ms base, 30 s first-stage cap) |
| 11-20 | 1 minute |
| 21-30 | 2 minutes |
| 31-40 | 3 minutes |
| 41-50 | 5 minutes maximum |
| After 50 | Forward the last retryable error to OMP fallback |

A small positive jitter remains on staged delays to avoid synchronized retries,
but no wait can exceed five minutes. Cancellation interrupts a pending wait.

Set OMP's global `retry.maxRetries` to `0`, as shown in
[`examples/config.yml`](examples/config.yml). The extension owns transient
retryable failures; disabling the outer retry loop prevents a fallback model's
502/503 response from starting a second retry budget. `retry.modelFallback`
remains enabled, so non-retryable failures can still traverse the configured
fallback chain once.

The current operational policy, exact failure-domain boundaries, fallback
cooldown behavior and diagnostic commands are recorded in
[`RETRY-STRATEGY.md`](RETRY-STRATEGY.md).

| Failure | Action |
|---|---|
| Concurrency/rate-limit 429 before text/tool/image | Queue and retry, shared 50-attempt budget |
| Explicit temporary server overload, including overload HTTP 503 | Queue and retry, shared 50-attempt budget |
| Stream/connection transport error before text/tool/image | Queue and retry, shared 50-attempt budget |
| 429 quota, credits or billing exhausted | Forward to OMP fallback |
| 401/403 authentication failure | Forward to OMP fallback |
| Model unavailable, no capacity or generic 5xx | Forward to OMP fallback |
| Error after text, tool call or image output | Forward unchanged; never replay partial output |

## Registered providers

| Provider | Endpoint | Model | Credential variable |
|---|---|---|---|
| `aiinput-queued` | `https://ai.input.im/v1` | `gpt-5.6-sol` | `AIINPUT_API_KEY` |
| `aiinput-overseas-queued` | `https://input.codes/v1` | `gpt-5.6-sol` | `AIINPUT_API_KEY` |
| `tokenking-queued` | `https://api.tokenskingdom.com/v1` | `gpt-5.6-sol` | `TOKENKING_API_KEY` |
| `tokenking-grok-queued` | `https://api.tokenskingdom.com/v1` | `grok-4.5` | `TOKENKING_GROK_API_KEY` |

No API key is stored in queue metadata. The lane identity hashes endpoint origin and credential scope with SHA-256.

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
TOKENKING_API_KEY=your-key
TOKENKING_GROK_API_KEY=your-key
```

Then merge the relevant fields from [`examples/config.yml`](examples/config.yml) into `~/.omp/agent/config.yml` and start a new OMP session.

### Existing manual extension

Do not load this package alongside another copy under `~/.omp/agent/extensions/adaptive-provider-queue`. Both copies register the same provider names. Keep the current manual extension active until the linked package has passed validation, then switch sources in one operation.

## Credential migration helper

The optional helper replaces inline credentials for the existing `aiinput` and `tokenking-grok` entries in `models.yml` with environment-variable references and writes the recovered values to `.env` using mode `0600`:

```bash
ruby scripts/migrate-credentials.rb ~/.omp/agent/models.yml ~/.omp/agent/.env
```

Back up both files first. The helper does not print credential values, but it mutates both targets atomically.

## Development

```bash
npm test
npm run pack:check
```

The tests cover error classification, retry-after parsing, Responses compatibility, cancellation, stale ticket cleanup, replay boundaries and FIFO coordination between separate processes.

## Compatibility

- Verified with OMP `17.2.2`.
- Uses OMP's `@oh-my-pi/pi-ai` and `@oh-my-pi/pi-coding-agent` runtime modules.
- The current source is OMP-native and is not declared compatible with standalone Pi.

## Runtime state

Tickets default to `~/.omp/run/adaptive-provider-queue/`. Lane directories are created with `0700`; ticket files use `0600`. Dead-process and stale tickets are removed during queue scans.

## License

Private personal package (`UNLICENSED`). Select an explicit license before public distribution.
