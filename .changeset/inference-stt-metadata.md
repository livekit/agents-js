---
'@livekit/agents': patch
---

feat(inference): propagate STT extra to SpeechData.metadata

The inference STT plugin now plumbs the gateway's per-transcript `extra` field
onto `SpeechData.metadata`, exposing provider-specific signals (e.g. Inworld
voice profile, xAI `speech_final`) to consumers.
