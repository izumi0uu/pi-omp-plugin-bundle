# Changelog

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
