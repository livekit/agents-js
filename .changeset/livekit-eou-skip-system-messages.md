---
'@livekit/agents-plugin-livekit': patch
---

fix(livekit): skip system and developer messages when building EOU input; the previous `in` check never matched and let those messages reach the end-of-utterance model as user turns
