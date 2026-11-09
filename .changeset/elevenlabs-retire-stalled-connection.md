---
'@livekit/agents-plugin-elevenlabs': patch
---

Add `TTS.retireConnection()` so a stalled multi-stream connection can be replaced, and close a retired connection as soon as no stream is left on it.
