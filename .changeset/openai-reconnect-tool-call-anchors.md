---
'@livekit/agents': patch
'@livekit/agents-plugin-openai': patch
---

Discard stale OpenAI Realtime tool outputs after reconnect when their original function-call anchor is no longer present in the active realtime session.
