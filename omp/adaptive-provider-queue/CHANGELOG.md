# Changelog

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
