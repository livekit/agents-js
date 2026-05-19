---
'@livekit/agents-plugin-soniox': patch
---

fix(soniox): add STT/TTS plugin reliability fixes

Adds the Soniox STT/TTS plugin with STT reconnect handling on silent WebSocket
closures, dominant-language tracking, lazy TTS stream config, empty-text handling,
and retryable error classification for transient TTS failures.
