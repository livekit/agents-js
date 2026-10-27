---
'@livekit/agents': patch
---

`SpeechStream.close()` and `VADStream.close()` detach their input stream, so closing an STT or VAD stream releases the reader lock on its audio source.
