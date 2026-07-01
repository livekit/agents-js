---
'@livekit/agents': minor
---

Promote the `WarmTransferTask` workflow out of beta. It now lives in the stable `workflows` namespace — import it as `workflows.WarmTransferTask` (with `workflows.WarmTransferResult`, `workflows.WarmTransferTaskOptions`, and `workflows.InstructionParts`) instead of `beta.WarmTransferTask`. The `beta` namespace continues to re-export these symbols as deprecated aliases for backward compatibility; they will be removed in a future release.
