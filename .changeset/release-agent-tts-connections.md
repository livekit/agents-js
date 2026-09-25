---
'@livekit/agents': patch
'@livekit/agents-plugin-cartesia': patch
'@livekit/agents-plugin-deepgram': patch
'@livekit/agents-plugin-fishaudio': patch
'@livekit/agents-plugin-inworld': patch
'@livekit/agents-plugin-rime': patch
'@livekit/agents-plugin-xai': patch
---

Release a TTS's pooled provider connections once nothing uses it any more. Every activity and session that uses a TTS instance counts as a user; when the last one closes, or `Agent.updateOptions` swaps the instance out, its idle connections close and any in-flight synthesis closes its connection when it finishes instead of returning it to the pool. Pooled websockets of a handed-off agent otherwise idled until the process exited. Instances shared between agents or sessions keep their connections until the last user is done, and a session's own TTS stays warm across every handoff. Adds `TTS.releaseIdleConnections()` and `ConnectionPool.releaseIdle()`, implemented by the inference TTS and the Cartesia, Deepgram, Fish Audio, Rime and xAI plugins. The Inworld stream now keeps one pool object for its whole lifetime, so an API key update mid-synthesis no longer strands its listener.
