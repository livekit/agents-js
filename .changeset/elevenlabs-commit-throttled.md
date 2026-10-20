---
'@livekit/agents-plugin-elevenlabs': patch
---

Pad an ElevenLabs Scribe v2 realtime commit with silence when less than 300ms of audio was sent since the previous one, so the server no longer answers `commit_throttled` and closes the session.
