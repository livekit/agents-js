---
'@livekit/agents': minor
---

Port async tool execution semantics from Python: tools can release their turn with `ctx.update()`,
`AsyncToolset` controls session/activity scope, and cancellable tools expose task-management helpers.
