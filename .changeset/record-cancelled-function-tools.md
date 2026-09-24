---
'@livekit/agents': patch
---

Record cancelled function tools instead of letting them vanish: a tool whose reply is aborted mid-execution now sets `lk.function_tool.cancelled` on its `function_tool` span, and the tool executor logs `tool cancelled` whenever a running tool is aborted.
