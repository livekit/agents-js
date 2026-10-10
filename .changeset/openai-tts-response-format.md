---
'@livekit/agents-plugin-openai': patch
---

fix(openai): reject TTS responses that aren't raw PCM instead of playing them as samples, and allow `responseFormat` to be set
