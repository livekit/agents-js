---
'@livekit/agents-plugin-elevenlabs': patch
---

Stop sending the final flush to an interrupted ElevenLabs context after closing it. ElevenLabs answered it with `context_closing` and closed the shared WebSocket, so the next reply failed with `tts_error` (#2983).
