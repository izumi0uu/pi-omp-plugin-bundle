# Changelog

## 0.1.0 - 2026-08-02

- Add adaptive, cross-process FIFO retry lanes for transient concurrency/rate-limit responses.
- Preserve unlimited initial concurrency when no queue backlog exists.
- Forward quota, billing, authentication, capacity and model-unavailable failures to OMP fallback.
- Restore OpenAI Responses compatibility metadata for custom queued providers.
- Register AI Input GPT 5.6 Sol and TokenKing Grok 4.5 queued providers.
