---
'@livekit/agents': patch
'@livekit/agents-plugin-silero': patch
---

Reset active VAD streams on flush so STT end-of-speech can recover without recreating streams. STT end-of-speech now preserves the VAD-owned `lastSpeakingTime` instead of overwriting it, keeping the end-of-turn "no new speech" check reliable when VAD is active.
