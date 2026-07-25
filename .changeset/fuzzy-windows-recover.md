---
'@livekit/agents': patch
'@livekit/agents-plugin-openai': patch
---

Recover OpenAI Responses WebSocket requests from stale pooled connections while preserving
connection API compatibility and cleaning up background connection work on shutdown.
