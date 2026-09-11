---
'@livekit/agents-plugin-sarvam': minor
---

Add `STTRealtime`, a Sarvam realtime speech-to-text plugin (`saaras:v3-realtime`) with server-side VAD, partial/final transcript gating, and per-connection usage reporting. Ported from `livekit/agents` (Python) PR #6562. Note: this stream never reconnects after a socket failure — Sarvam bills per connection, so `stream()` forces `connOptions.maxRetry` to `0`.
