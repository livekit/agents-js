---
'@livekit/agents': patch
---

fix(stt): close the inference STT socket when the stream is closed while it is still connecting, instead of holding it open until the 30s finalization timeout
