---
'@livekit/agents': patch
---

`AgentSession` binds its input and output change callbacks, so assigning `session.input.audio` on a running session attaches the new input to the current activity, and the warning for an audio output that cannot pause is logged.
