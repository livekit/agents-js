---
'@livekit/agents': patch
---

Fix `AgentActivity.generateReply` defaulting `toolChoice` to `'none'` on a child `AgentSession` spawned inside a tool. The previous check relied on `AsyncLocalStorage`, which leaks the parent function-call context into the child session and caused the framework to drop legitimate tool calls emitted by the child agent (e.g. the supervisor's `connect_to_caller` invocation in `WarmTransferTask`). The check now uses per-task info, matching the Python implementation.
