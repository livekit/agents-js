---
'@livekit/agents-plugin-google': patch
---

Gemini realtime: restart the session when the WebSocket closes abnormally (e.g. code 1006), mirroring the network-error path - the main task reconnects and re-seeds the chat context instead of leaving the session parked on a dead socket. The emitted error is marked recoverable when a restart will happen.
