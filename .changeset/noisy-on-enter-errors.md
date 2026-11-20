---
'@livekit/agents': patch
---

Log an exception thrown from `Agent.onEnter()` (`error in onEnter`). It was dropped without a trace when the agent was activated by `session.start()`, `session.updateAgent()` or a tool handoff.
