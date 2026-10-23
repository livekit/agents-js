---
'@livekit/agents': patch
---

Cancel pending TTS and transcript stream reads when speech is interrupted so cleanup does not delay the next reply.
