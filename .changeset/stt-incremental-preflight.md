---
'@livekit/agents': patch
'@livekit/agents-plugin-assemblyai': patch
---

Add the `incrementalPreflight` STT capability for providers whose preflight transcripts carry only the words since the previous preflight. The AssemblyAI plugin sets it.
