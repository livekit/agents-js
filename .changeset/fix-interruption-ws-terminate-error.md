---
'@livekit/agents': patch
---

Keep an error listener attached on terminated or abandoned adaptive interruption WebSockets so asynchronous `abortHandshake` errors do not throw uncaught exceptions.
