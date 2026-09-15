---
'@livekit/agents': patch
---

Reject late inline AgentTasks on an outgoing activity so handoff and shutdown do not deadlock while draining non-cancellable tools.
