---
'@livekit/agents': patch
'@livekit/agents-plugin-silero': patch
---

Reset active VAD streams on flush so STT end-of-speech can recover without recreating streams.
