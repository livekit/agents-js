---
'@livekit/agents': patch
---

fix(voice): cancel a speech that `scheduleSpeech` refuses while scheduling is paused, so its speech task does not stay parked and block the next `drain()`/`pause()` and `AgentSession.close()`
