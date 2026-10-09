---
'@livekit/agents-plugin-openai': patch
---

`RealtimeSession.close()` waits for the session task and closes the WebSocket, instead of leaving an idle connection open until the server drops it or `maxSessionDuration` passes.
