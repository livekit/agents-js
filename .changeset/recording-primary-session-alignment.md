---
'@livekit/agents': patch
---

Align `AgentSession.start` recording with the Python SDK's primary-session behavior. The primary/secondary designation now happens in `start()` before `initRecording`, so a demoted secondary session never configures cloud recording. A non-primary session whose `record` argument was not explicitly given now silently disables its recording (instead of throwing); it still throws only when `record` was passed explicitly, matching Python's `record_is_given` semantics.
