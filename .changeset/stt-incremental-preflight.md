---
'@livekit/agents': patch
'@livekit/agents-plugin-assemblyai': patch
---

Add `SpeechEvent.incremental` for preflight transcripts that may cover only part of the segment, such as the words since the previous preflight. The AssemblyAI plugin sets it.
