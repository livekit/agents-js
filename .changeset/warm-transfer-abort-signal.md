---
'@livekit/agents': minor
---

Add cooperative cancellation to `WarmTransferTask` via a new `abortSignal` option: aborting stops dialing, ringing, or consulting — a human agent who already answered is told the transfer ended before their call is — and the task completes with the signal's reason, while a participant move that has already committed wins over a concurrent abort. On failure or cancellation, `run()` now rejects only after teardown has finished (bounded by an internal deadline), restoring caller I/O last; on success it resolves as soon as the move commits, as before. A cancelled SIP dial that answers late is compensated by deleting the consult room it may have recreated. `AgentSession.shutdown()` now returns a promise that resolves once the session has fully closed.
