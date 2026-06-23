---
'@livekit/agents': minor
---

Promote the `TaskGroup` workflow out of beta. It now lives in the stable `workflows` namespace — import it as `workflows.TaskGroup` (with `workflows.TaskCompletedEvent`, `workflows.TaskGroupOptions`, and `workflows.TaskGroupResult`) instead of `beta.TaskGroup`. The `beta` namespace continues to re-export these symbols as deprecated aliases for backward compatibility; they will be removed in a future release.
