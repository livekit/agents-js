---
'@livekit/agents': minor
---

Add cooperative cancellation and a teardown-complete lifecycle to `WarmTransferTask`. The new `abortSignal` option cancels the transfer cooperatively — stopping dialing, ringing, or consulting and completing the task with the signal's reason — while a participant move that has already committed wins over a concurrent abort. `run()` now settles only after teardown has finished: caller hold audio stopped, caller I/O restored, any human-agent notification spoken, and the human agent session (including its room cleanup) shut down. `AgentSession.shutdown()` now returns a promise that resolves once the session has fully closed.
