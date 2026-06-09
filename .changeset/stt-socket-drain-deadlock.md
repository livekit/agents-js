---
'@livekit/agents': patch
---

Fix a teardown deadlock that could leave an inference STT websocket lingering after a participant disconnect. On a forced session close (e.g. `closeOnDisconnect`), `AgentSession` awaited `activity.drain()` unbounded while it held the activity lock; if a speech task never settled, drain hung forever and `activity.close()` — which aborts the STT/realtime/TTS sockets — was never reached, so the orphaned STT socket was repeatedly closed by the server for inactivity and retried. Forced closes now bound the drain and, on timeout, force-cancel the scheduling task (`AgentActivity.forceCancelSchedulingTask`) so the lock is released and resource teardown always runs. Graceful drains (agent handoff, `shutdown({ drain: true })`) are unchanged.

Also route `AgentSession.close()` through the shared `closingTask` so a direct `close()` racing a `_closeSoon()` (e.g. `closeOnDisconnect` firing alongside `ctx.shutdown()`) can no longer run the close path twice.

Stop the STT streaming retry budget from eroding over a long-lived stream: `SpeechStream` now keeps a persistent retry counter and resets it on every successful `FINAL_TRANSCRIPT` (matching the Python framework), so a stream that works, drops, and reconnects no longer counts old failures toward `maxRetry`.
