# OMP Task Provider Handoff

Safe mid-run replacement coordinator for OMP task agents.

## Why replacement, not hot mutation

OMP 18 does not expose a public API to change the provider/model of an already
running child session. The extension therefore never mutates a child `model`,
`model.api`, credential, or session object. It prepares a handoff and queues an
instruction for the parent Agent to run the public lifecycle operations:

```text
source child -> hub send handoff -> hub wait -> hub cancel -> task with target profile
```

The new child is a separate session. It receives the old transcript address
(`history://<source-id>`), the handoff reply, the original acceptance criteria,
and the requested target agent/profile. This makes the boundary explicit and
keeps concurrent requests from sharing mutable provider state.

## Commands

```text
/task-handoff <source-agent-id> [target-agent-profile] [reason]
/task-replace <source-agent-id> <target-agent-profile> [reason]
```

`/task-replace` requires a target profile. `/task-handoff` defaults to the
generic `task` profile when no target is supplied. A target is an OMP task-agent
name, not a bare provider or model selector. For example:

```text
/task-replace TerraWorker tokenking-terra-max-executor AI Input is unavailable
```

The command queues a follow-up turn. The parent Agent must confirm the child
with `hub list`/`hub jobs`, request a handoff with `hub send` and `await: true`,
cancel only after a reply (unless the user explicitly asks to discard it), and
then create the replacement with `task`.

## Model tool

The `task_provider_handoff` tool exposes the same operation to the parent Agent:

```json
{
  "sourceAgentId": "TerraWorker",
  "targetAgent": "tokenking-terra-max-executor",
  "reason": "AI Input is unavailable",
  "task": "Continue the original implementation and preserve the acceptance criteria",
  "timeoutMs": 30000
}
```

The result field `orchestrationQueued: true` means only that the follow-up
message was queued. It is not proof that a replacement happened. The parent
must report the real `hub` and `task` results, including the new child id and
resolved model.

`explicitHandoff` can be used when the caller already has a concise handoff
record. Free-form text is bounded and passed as context, never as an agent or
provider selector.

## Installation

Install the bundle root so the extension is discovered with the other OMP
extensions:

```bash
omp plugin link /path/to/pi-omp-plugin-bundle
```

Do not install both the bundle and this subpackage at the same time. Restart
OMP or run `/reload` after linking.

## Limits

- This is not an in-place provider switch. A running child keeps its original
  provider until it is stopped.
- The handoff message can be delivered while the parent is streaming, but the
  replacement starts in a follow-up turn after the current tool call settles.
- If the source never replies, the parent must decide whether to leave it
  running or cancel it. The plugin does not silently discard unfinished work.
- Retry/fallback remains responsible for request-level failures; this extension
  only coordinates task-agent lifecycle replacement.
