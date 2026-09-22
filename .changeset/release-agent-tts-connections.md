---
'@livekit/agents': patch
'@livekit/agents-plugin-cartesia': patch
'@livekit/agents-plugin-deepgram': patch
'@livekit/agents-plugin-fishaudio': patch
'@livekit/agents-plugin-inworld': patch
'@livekit/agents-plugin-rime': patch
'@livekit/agents-plugin-xai': patch
---

Release an agent-owned TTS's pooled provider connections when that agent's activity closes, unless the next agent synthesizes with the same instance. Pooled websockets of a handed-off agent otherwise idled until the process exited. A session-level TTS is unaffected and keeps its connections warm across handoffs. Adds `TTS.releaseConnections()`, implemented by the inference TTS and the pooled plugin TTSes.
