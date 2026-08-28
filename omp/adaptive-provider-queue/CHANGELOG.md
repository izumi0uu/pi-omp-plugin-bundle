# Changelog

## Unreleased

- Add guarded `/provider-remove` and `/provider-delete` commands for listing
  configured providers, removing one exact `provider/model`, or removing a
  whole provider from `models.yml`. Deletions support `--dry-run`, interactive
  confirmation, `--yes`, and `--force`, create timestamped backups, preserve
  credentials, and use atomic replacement.
- Document AgentRouter long-session socket disconnects, the distinction between a
  new OMP window and a new session, and the no-replay boundary after partial output.
- Classify Anthropic streams that end before `message_stop` as transient
  transport failures, while retaining the existing no-replay guard after
  substantive output.
- Log when a retryable stream is intentionally not replayed because partial
  text, tool-call, or image output has already crossed the replay boundary.
- Make `retry-stop` exhaustion parent-visible for subagents: emit a terminal
  `error` with the `ADAPTIVE_RETRY_EXHAUSTED` marker, preserve a bounded
  credential-redacted provider report in child output, and retain OMP's Abort
  classification only to suppress a second retry/fallback pass.
- Revalidate the transport and terminal-error classification against OMP
  `18.0.0`.
- Replace provider-specific `*-queued` registrations with one universal model
  transport wrapper. Every model request dispatched through OMP `streamSimple`
  now receives the retry policy while preserving its original selector,
  credentials, model metadata, and API transport.
- Add an AI Input endpoint router for `ai.input.im`, `eo.input.codes`, and
  `input.codes`. It scores only latency EWMA plus 1.5 times jitter EWMA, probes
  every 30 seconds, retains eight samples, and uses two-round 20% hysteresis.
- Keep all provider-error semantics in Universal Retry. Transport and generic
  `502/503/504/524` failures temporarily exclude the current AI Input URL for the
  next attempt; rate limits, authentication, quota, and model failures do not.
- Add `/aiinput-route status|refresh|auto|pin`, credential-free shared automatic
  route state, cancellation-safe initial probing, and one logical AI Input
  retry lane across routed URLs. Manual pins are session-scoped, accept the
  `ai`, `eo`, and `input` aliases, and optionally expire after a bounded
  duration such as `30m` or `2h`.
- Keep latency probes and the cached automatic candidate active during a
  session pin. A pin overrides Retry URL exclusions until it expires or that
  session returns to `auto`; other top-level OMP sessions remain independent.
- Bind persisted route-policy entries to their originating session ID. Resuming
  that session restores its pin, while a fork that copies the branch entries
  starts in automatic routing instead of inheriting the source session's pin.
- Resolve OMP's rotating and derived provider request IDs through the owning
  provider-state object and parent lineage. `/fresh`, `/clear`, Advisor,
  `/btw`, and `/tan` therefore retain the current session's route without
  leaking it to a different session.
- Restore route policy from the complete session entry set while leaving retry
  policy branch-local, so history-tree navigation cannot silently clear a
  session-wide endpoint pin.
- Keep the shared route-state schema readable by already-open extension
  instances during rolling reload. New instances omit global pin fields; old
  instances therefore read the shared state as `auto` instead of resetting it.
- Keep concurrent probe cancellation request-local, abort old probes on reload,
  follow OMP's provider-aware proxy selection, and fail open when local route
  state is unavailable.
- Preserve the cached selected URL when every endpoint lacks a sample in the
  current probe round; a request-local Retry exclusion still takes precedence.
- Exercise endpoint rotation with the real Router and Retry implementations,
  including sole-waiter cancellation followed immediately by a new request.
- Resolve an AI Input credential once per logical request, then seed OMP's
  original resolver so the probe, retry lane, and first model attempt retain
  credential affinity without disabling later auth refresh or account rotation.
- Remove the active `aiinput-overseas` provider alias; the single `aiinput`
  selector now routes across all three URLs.
- Remove `aiinput-queued`, `aiinput-overseas-queued`,
  `aiinput2-overseas-queued`, `tokenking-queued`,
  `tokenking-grok-queued`, and `kimi-code-queued`, along with the Kimi and
  Responses adapter code used only by those aliases.
- Verify the universal transport path with OMP `17.3.5`, including a real
  provider-dispatch smoke test that recovers from an HTTP 500 overload through
  the original API transport.
- Make `retry-stop` the default for new sessions and sessions without a saved
  policy, so managed failures exhaust their local 50-retry budget without
  entering OMP fallback.
- Treat OMP's status-less `Unable to connect` transport error as retryable, so
  adaptive retry modes handle local proxy and endpoint connection failures
  instead of immediately entering OMP fallback.
- Bridge configured `anthropic-beta` values into the final outgoing request
  through a request-local `fetch` wrapper as well as OMP's protected `betas`
  option. This preserves and deduplicates existing beta values on OMP releases
  that discard `betas` during option normalization, without changing global
  `fetch` or non-Anthropic transports.
- Bridge `agentrouter/gpt-5.6-sol` through OMP's accepted Codex request
  transport while rewriting only AgentRouter's unsupported Codex response path
  to `/v1/responses`. The request-local adapter preserves Codex identity,
  credentials, proxy and retry state without changing global `fetch` or other
  providers.
- Recognize `agentrouter`, `agentrouter-2`, and `agentrouter-3` as one fallback-
  compatible provider family. Explicit AgentRouter quota exhaustion is handed
  to OMP immediately so the configured account chain can advance without a
  50-attempt retry delay.

## 0.7.0 - 2026-08-12

- Add `/adaptive-5xx retry-stop`. Managed pre-content transient failures use an
  isolated 50-retry budget; exhaustion emits an explicit aborted turn so OMP
  does not traverse the fallback chain.
- Route pre-content `401/402/403`, revoked or invalid credentials,
  quota/credits/billing exhaustion and explicit model/capacity/route
  unavailability through the same 50-retry campaign. In `retry`, exhaustion
  reaches OMP fallback; in `retry-stop`, exhaustion ends the turn.
- Add `/adaptive-5xx list`, including a marker for the active mode and concise
  behavior descriptions.
- Make `/adaptive-5xx toggle` cycle in the documented order: `retry`,
  `retry-stop`, `retry-5m`, `fallback`, then back to `retry`.

## 0.6.0 - 2026-08-12

- Add `/adaptive-5xx retry-5m`, which retries ordinary pre-content
  `502/503/504` failures on the current provider for at most five wall-clock
  minutes before allowing OMP fallback. Esc cancels the retry window without
  switching providers.
- Cap the final backoff at the remaining retry window and stop before another
  upstream request once the deadline is reached. Abort an in-flight retry at the
  deadline while preserving the last generic 5xx for fallback; remove the timer
  after substantive output and make Esc win deadline races.
- Keep explicit overload, rate-limit and transport failures on their independent
  50-attempt budget even after a generic 5xx. Authentication, quota, model
  availability and other immediate-fallback routing remain unchanged.
- Keep the fixed window request-local by forcing shared recovery off in this
  mode, persist the selection through resume and subagent lineage, and show a
  replaceable time-based progress bar with the remaining fallback delay.

## 0.5.1 - 2026-08-11

- Register `aiinput2-overseas-queued` for GPT 5.6 Sol on the overseas AI Input
  endpoint, isolated from account 1 by the `AIINPUT2_API_KEY` credential lane.
- Extend the credential migration helper to move both AI Input accounts and
  their domestic/overseas aliases to environment-variable references.

## 0.5.0 - 2026-08-11

- Make cross-window retry sharing opt-in and default new or unrecorded sessions,
  as well as low-level stream calls that omit the option, to isolated
  request-local recovery.
- Add `/adaptive-share status|on|off|toggle`, persist the choice in session
  history, restore it across resume/tree navigation, and keep subagents on the
  root session's policy.
- Bypass all ticket, retry-state and recovery-marker operations in isolated
  mode while retaining the same 50-attempt staged backoff and original-error
  fallback behavior.
- Show local retry progress without a queue position and combine the persistent
  policy status as `5xx: ... | shared: on/off`.
- Preserve the existing cross-process FIFO implementation behind explicit
  shared mode. Existing shared files are ignored, not deleted, while sharing is
  off so older OMP windows are not disrupted during reload.

## 0.4.2 - 2026-08-11

- Show queued recovery in one replaceable OMP status slot instead of emitting
  repeated notifications. The compact progress bar includes provider, shared
  attempt count, failure kind and queue position, and clears when recovery
  succeeds, the stream ends or the request is cancelled.
- Scope progress to requests with the active interactive session ID, share its
  generation across extension instances, and prevent an older stream from
  clearing or overwriting a newer stream's status.
- Replace process-relative `hrtime` ticket ordering with a publication-locked,
  lane-wide sortable order so later OMP processes cannot jump ahead of a live
  ticket or retry-state lock. A queue head is stabilized while holding the same
  lock, so a still-running pre-0.4.2 process cannot displace the active owner
  during reload. Strict FIFO resumes after every older window reloads.
- Replace cross-process recovery-time comparisons with a shared recovery
  generation while retaining a version-1-compatible marker envelope during a
  rolling reload.

## 0.4.1 - 2026-08-11

- Keep the current generic-5xx policy visible in the status bar for both modes:
  `5xx: retry 50x` or `5xx: immediate fallback`.
- Resolve policy from a process-wide, session-keyed store and stable artifact
  lineage, so subagent extension registration or a later root-session switch
  cannot replace a detached subagent's effective provider policy.
- Restore policy after session-tree navigation and persist changes through the
  public `pi.appendEntry` extension API.
- Give explicit concurrency/rate-limit and `server_is_overloaded` semantics
  priority over a `502/503/504` status, so those failures still retry in either
  session mode.
- Let a successful fallback-mode health probe clear the exact generic-5xx
  recovery campaign it observed without deleting a newer concurrent campaign.
- Serialize retry-state reads and writes through a cross-process FIFO state
  lock so snapshot cleanup cannot expose a missing file and reset the attempt
  counter during a concurrent failure update.
- Atomically serialize queue and state-lock file publication so an older
  sortable coordination name cannot appear after a newer owner has entered.
- Keep coordination files owned by a live PID even if their heartbeat is old,
  avoiding split-brain probes after system sleep or a long event-loop stall.
- Retain a short-lived recovery marker so a concurrent failure that reaches
  the queue after the successful owner has exited does not restart attempt 1.

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
