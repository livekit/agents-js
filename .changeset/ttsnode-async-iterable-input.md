---
'@livekit/agents': patch
---

Pipeline nodes (`ttsNode`, `sttNode`, `transcriptionNode`, `realtimeAudioOutputNode`) now accept an async generator/iterable as their stream input, so overrides can pass a generator directly without wrapping it in `toStream()` first.
