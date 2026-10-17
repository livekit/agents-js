---
'@livekit/agents-plugin-elevenlabs': patch
---

Redial a Scribe realtime socket that stops answering pings and replay the audio it had not committed, and wrap input read failures in a retryable `APIConnectionError`.
