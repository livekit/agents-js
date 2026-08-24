---
'@livekit/agents': patch
---

Add an optional `abortSignal` to `WarmTransferTask`. Aborting stops waiting for a pending dial or ends an active consultation, and `run()` rejects with the signal reason.
