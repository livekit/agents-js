---
'@livekit/agents-plugin-openai': patch
'@livekit/agents-plugin-baseten': patch
---

fix(openai,baseten): wire TTS `close()` to cancel in-flight synthesis requests
