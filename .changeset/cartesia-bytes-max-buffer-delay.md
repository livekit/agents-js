---
'@livekit/agents-plugin-cartesia': patch
---

Stop sending the websocket-only `max_buffer_delay_ms` field on `/tts/bytes` requests, which Cartesia rejects with HTTP 400.
