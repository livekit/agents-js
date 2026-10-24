---
'@livekit/agents': patch
---

Commit an STT final that arrives after END_OF_SPEECH already committed the previous utterance, instead of holding it for the next END_OF_SPEECH
