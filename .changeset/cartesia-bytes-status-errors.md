---
'@livekit/agents-plugin-cartesia': patch
---

Surface rejected `/tts/bytes` responses as `APIStatusError` instead of ending with silent empty audio.
