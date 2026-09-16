---
'@livekit/agents-plugin-google': patch
---

Stamp `type: 'realtime_model_error'` on the Gemini Live error event so `AgentSession` forwards it as `AgentSessionEventTypes.Error` instead of dropping it; the OpenAI realtime plugins already do.
