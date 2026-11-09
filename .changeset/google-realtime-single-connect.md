---
'@livekit/agents': patch
'@livekit/agents-plugin-google': patch
'@livekit/agents-plugin-phonic': patch
'@livekit/agents-plugin-xai': patch
---

`RealtimeModel.session()` now accepts the initial instructions, chat context, and tools, and the agent passes them when it creates a session. A Gemini Live session with tools or instructions now connects once at startup instead of twice (#2324). The OpenAI, LiveKit Inference, xAI, and Phonic realtime sessions also apply these options, so a session you create directly starts configured.

Each Gemini Live session now keeps its own copy of the model options, so one session's instructions no longer change another session's. `RealtimeModel.updateOptions()` on the Google plugin now applies to open sessions, as in the Python plugin.
