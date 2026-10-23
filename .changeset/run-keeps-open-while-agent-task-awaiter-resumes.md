---
'@livekit/agents': patch
---

Record `say()` speech in the active `RunResult`, and keep the run open while an `AgentTask`'s awaiter resumes after `complete()`, so `session.run()` no longer returns before the next task in a chain (or a `TaskGroup`) has spoken.
