---
'@livekit/agents-plugin-soniox': patch
---

Fix Soniox TTS after a retried connection: text pushed after the retry is still sent instead of dropped with the closed input.
