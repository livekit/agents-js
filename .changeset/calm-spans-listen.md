---
'@livekit/agents': patch
---

Clamp a backdated `user_speaking` span end to its start so VAD and STT clock differences cannot produce a negative trace duration.
