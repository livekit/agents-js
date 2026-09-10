---
'@livekit/agents': patch
---

Stop `session.interrupt({ force: true })` from crashing the process with `SpeechHandleCircularWaitError` when called inside a function tool.
