---
'@livekit/agents': patch
'@livekit/agents-plugin-google': patch
'@livekit/agents-plugin-phonic': patch
'@livekit/agents-plugin-xai': patch
---

`RealtimeModel.session()` now accepts the initial instructions, chat context, and tools, and the agent passes them when it creates a session. A Gemini Live session with tools or instructions now connects once at startup instead of twice (#2324). The OpenAI, LiveKit Inference, xAI, and Phonic realtime sessions also apply these options, so a session you create directly starts configured.
