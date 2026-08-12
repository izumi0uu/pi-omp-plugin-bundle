# Changelog

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
