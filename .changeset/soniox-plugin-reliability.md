---
'@livekit/agents-plugin-soniox': patch
---

fix(soniox): add TTS reliability fixes

Adds Soniox TTS support with lazy stream config, empty-text handling, and
retryable error classification for transient TTS failures.
