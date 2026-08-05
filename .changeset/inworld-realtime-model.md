---
'@livekit/agents-plugin-inworld': patch
'@livekit/agents-plugin-openai': patch
---

Add `inworld.realtime.RealtimeModel`, a speech-to-speech Realtime model backed by the Inworld Realtime API. It subclasses the OpenAI Realtime plugin and overrides only auth, URL construction, and the Inworld-specific fields on `session.update`. To make that possible, `RealtimeSession.createWsConn()`, `RealtimeSession.createSessionUpdateEvent()`, `RealtimeSession.oaiRealtimeModel`, and `RealtimeSession._options` in the OpenAI plugin are now `protected` rather than `private`.
