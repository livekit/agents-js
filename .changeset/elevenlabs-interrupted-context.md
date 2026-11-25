---
'@livekit/agents-plugin-elevenlabs': patch
---

Stop sending the final flush to an interrupted ElevenLabs context after closing it, so the server no longer answers `context_closing` and closes the shared WebSocket before the next reply.
