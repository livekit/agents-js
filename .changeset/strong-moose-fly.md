---
'@livekit/agents-plugin-openai': patch
'@livekit/agents': patch
---

fix openai-realtime by removing buggy resolveGeneration method that used wrong key lookup
