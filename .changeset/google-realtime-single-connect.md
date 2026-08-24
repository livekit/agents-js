---
'@livekit/agents': patch
'@livekit/agents-plugin-google': patch
'@livekit/agents-plugin-openai': patch
'@livekit/agents-plugin-phonic': patch
'@livekit/agents-plugin-xai': patch
---

Realtime: `RealtimeModel.session()` now accepts the initial instructions, chat context, and tools, and the framework passes them at creation. Gemini realtime sessions with tools (or agent instructions) previously established a first connection only to tear it down and reconnect once the configuration arrived; they now connect once. The OpenAI, xAI, and Phonic realtime plugins honor the same options so a directly created session starts configured.
