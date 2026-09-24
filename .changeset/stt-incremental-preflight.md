---
'@livekit/agents': patch
'@livekit/agents-plugin-assemblyai': patch
---

Add `SpeechEvent.incremental` for preflight transcripts that carry only the words since the previous preflight. The AssemblyAI plugin sets it.
