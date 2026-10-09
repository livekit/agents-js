---
'@livekit/agents': patch
---

`AgentSession` binds its input and output change callbacks, so assigning `session.input.audio` on a running session switches the activity to the new input, and the warning for an audio output that cannot pause is logged.
