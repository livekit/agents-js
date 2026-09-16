---
'@livekit/agents-plugin-deepgram': patch
---

Add `TTSv2`, a Deepgram Flux TTS client for the `/v2/speak` endpoint, alongside the existing Aura `TTS` rather than replacing it. Streaming and batch output are `linear16` only.
