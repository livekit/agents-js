---
'@livekit/agents': patch
---

Adds base `Toolset` support: a stateful container for a group of tools with `setup()` / `aclose()` lifecycle hooks. Toolsets can be passed directly into `Agent({ tools: [...] })` alongside individual function tools; their tools are flattened into the agent's `ToolContext` and the runtime drives `setup()` on activity start, `aclose()` on close, and a diff on `updateTools()`. `Toolset.setup()` failures propagate (with rollback of successfully-set-up toolsets) so the agent fails explicitly rather than running with uninitialized resources. The `IGNORE_ON_ENTER` flag is also respected for function tools nested inside a Toolset. Every LLM and realtime plugin tool builder iterates `ToolContext.flatten()` so toolset-contributed tools are correctly advertised. Also exports `ToolCalledEvent` / `ToolCompletedEvent` payload types.
