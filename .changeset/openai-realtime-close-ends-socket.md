---
'@livekit/agents': patch
---

`RealtimeSession.close()` now waits for the session task and closes the WebSocket, including mid-reply or mid-handshake, instead of leaving the connection open until the server drops it or `maxSessionDuration` passes. `Task.cancelAndWait` clears its timeout when the task settles first.
