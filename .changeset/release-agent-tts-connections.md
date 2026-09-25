---
'@livekit/agents': patch
'@livekit/agents-plugin-cartesia': patch
'@livekit/agents-plugin-deepgram': patch
'@livekit/agents-plugin-fishaudio': patch
'@livekit/agents-plugin-inworld': patch
'@livekit/agents-plugin-rime': patch
'@livekit/agents-plugin-xai': patch
---

Release the idle pooled connections of a TTS the framework built from a model string once it is done with it: when the agent's activity closes, when `Agent.updateOptions` replaces it, and when the session closes. Such an instance has no other user, so this is safe by construction; a TTS instance the user constructed is never released automatically. Pooled websockets of a handed-off agent otherwise idled until the process exited. Release is idle-only, so an in-flight synthesis keeps its connection. Adds `TTS.releaseIdleConnections()` and `ConnectionPool.releaseIdle()`, implemented by the inference TTS and the Cartesia, Deepgram, Fish Audio, Rime and xAI plugins. The Inworld stream now keeps one pool object for its whole lifetime, so an API key update mid-synthesis no longer strands its listener.
