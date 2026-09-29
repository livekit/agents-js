---
'@livekit/agents-plugin-neuphonic': patch
---

Close the Neuphonic TTS WebSocket when a stream is closed or interrupted, instead of leaving it open until the server drops it.
