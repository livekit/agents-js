---
'@livekit/agents': patch
---

Sanitize turn detector for session reports: the OTLP attribute serializer now honors `toJSON()`, and the audio turn detector exposes a credential-free config snapshot.
