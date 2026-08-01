# Adaptive Provider Queue for OMP

OMP 原生 provider extension。正常状态不设置固定并发上限；只有上游返回可重试的并发/限流错误后，才为同一 endpoint + API key 建立跨 OMP 进程共享的 FIFO 队列。

## Behavior

```text
OMP request
  -> send immediately when no backlog exists
  -> pre-content transient 429
  -> join credential-scoped FIFO lane
  -> retry with exponential backoff
  -> release lane after the whole stream terminates
```

| Failure | Action |
|---|---|
| Pre-content concurrency/rate-limit 429 | Queue and retry |
| 429 quota, credits or billing exhausted | Forward to OMP fallback |
| 401/403 authentication failure | Forward to OMP fallback |
| Model unavailable, no capacity or 5xx | Forward to OMP fallback |
| Error after semantic content started | Forward unchanged; never replay partial output |

## Registered providers

| Provider | Endpoint | Model | Credential variable |
|---|---|---|---|
| `aiinput-queued` | `https://ai.input.im/v1` | `gpt-5.6-sol` | `AIINPUT_API_KEY` |
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
