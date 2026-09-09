---
'@livekit/agents-plugin-phonic': patch
---

Add `allow_tool_chaining` to the Phonic plugin's per-tool `configsForTools`. Defaults to `false`; set it per tool to allow another tool call immediately after that tool's output.
