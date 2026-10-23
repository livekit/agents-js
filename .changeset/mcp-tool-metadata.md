---
'@livekit/agents': patch
---

Preserve MCP tool metadata as `FunctionTool.meta` so applications can inspect it during tool filtering and execution. Omit empty MCP metadata and keep application metadata out of provider tool schemas.
