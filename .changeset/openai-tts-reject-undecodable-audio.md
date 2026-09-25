---
'@livekit/agents-plugin-openai': patch
---

fix(openai): reject TTS bodies that aren't raw PCM instead of playing them as samples, and allow response_format to be set
