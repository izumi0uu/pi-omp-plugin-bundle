# Changelog

## 0.4.0 - 2026-08-11

- Add `/adaptive-5xx status|retry|fallback|toggle` to choose generic upstream
  `502/503/504` handling for the current session. New sessions default to the
  shared 50-attempt retry campaign; fallback mode forwards the first generic
  upstream 5xx failure to OMP.
- Persist the choice in session history so resume and branch history restore it,
  expose fallback mode in the status bar, and keep root subagents on the active
  root-session policy.
- Keep explicit concurrency/rate-limit, server overload and status-less
  transport failures retryable in either mode. Preserve immediate fallback for
  authentication, quota, billing and explicit model-unavailable failures.
- Record the optional HTTP status in shared retry state so fallback-mode
  sessions can bypass an active generic-5xx campaign without exhausting or
  corrupting the campaign used by other OMP windows.

## 0.3.1 - 2026-08-11

- Treat generic upstream `502`, `503` and `504` responses before substantive
  output as recoverable transport failures that consume the shared 50-attempt
  budget. A temporary `503` can no longer mark a lane exhausted at `1/50` and
  force concurrent OMP windows into fallback.
- Preserve immediate fallback for authentication, quota, billing, explicit
  model-unavailable and no-capacity failures.

## 0.3.0 - 2026-08-11

- Register `kimi-code-queued` with adaptive queue transport for all seven Kimi
  Code models exposed by the extension.
- Reuse the credential stored by OMP's built-in `kimi-code` login through a
  command-backed provider value, without copying a Kimi key into the repository
  or requiring one in `.env`.
- Keep the built-in `kimi-code` selector available as the direct, non-queued
  transport for callers that explicitly choose it.
- Raise the verified OMP runtime to `17.2.12`, whose `streamKimi` export and
  model contract back this provider.

## 0.2.0 - 2026-08-11

- Share one persisted retry campaign across every OMP process using the same
  endpoint and credential lane; only the FIFO head probes provider recovery.
- Clear shared state on successful or substantive output. Keep exhausted state
  for five minutes so waiting and newly arriving requests reach OMP fallback
  without contacting the unhealthy upstream.
- Let the next live queue head claim an active campaign after cancellation or
  process exit without resetting its retry count or deadline.
- Write credential-free lane state through atomic replacement. API keys remain
  represented only by the existing hashed lane identity.

## 0.1.4 - 2026-08-11

- Treat explicit temporary server-overload responses as retryable congestion,
  including `server_is_overloaded`, the same message wrapped as `server_error`,
  and explicit overload responses carrying HTTP 503.
- Keep generic 5xx, model-unavailable and no-capacity failures on the immediate
  fallback path.

## 0.1.3 - 2026-08-11

- Use one 50-attempt staged retry budget for transient rate limits and transport
  failures instead of a separate three-attempt transport budget.
- Treat thinking-only and redacted-thinking output as replayable while retaining
  the hard no-replay boundary after text, tool calls or images.
- Retry first-event timeouts and incomplete response streams as transport
  failures.

## 0.1.2 - 2026-08-10

- Retry pre-content stream and connection read failures up to three times with
  a short capped backoff before handing the error to OMP fallback.
- Suppress duplicate thinking and stream envelope events across transport
  retries while preserving the no-replay boundary after text or tool output.

## 0.1.1 - 2026-08-10

- Bound transient rate-limit retries to 50 attempts.
- Add ten-attempt staged backoff ending at a five-minute cap.
- Forward the final rate-limit error to OMP fallback after the retry budget is exhausted.
- Disable OMP's outer retry loop in the example configuration so fallback 5xx
  failures do not start a second 50-attempt retry cycle.
- Register the overseas AI Input and TokenKing Sol queued providers in the
  canonical bundle source.
- Document the two-selector TokenKing fallback chain and its shared upstream
  failure boundary.

## 0.1.0 - 2026-08-02

- Add adaptive, cross-process FIFO retry lanes for transient concurrency/rate-limit responses.
- Preserve unlimited initial concurrency when no queue backlog exists.
- Forward quota, billing, authentication, capacity and model-unavailable failures to OMP fallback.
- Restore OpenAI Responses compatibility metadata for custom queued providers.
- Register AI Input GPT 5.6 Sol and TokenKing Grok 4.5 queued providers.
