---
'@livekit/agents': patch
---

Reuse the STT pipeline across agent handoffs and task transitions for agents built with `Agent.create()` / `AgentTask.create()`. The generated classes always override `sttNode`, so the reuse check treated them as custom nodes and every transition closed the STT connection and opened a new one, even when no `sttNode` hook was given.
