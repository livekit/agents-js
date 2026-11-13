---
'@livekit/agents': patch
---

Fix unbounded memory growth in `AudioRecognition` when no VAD or STT is configured (e.g. `realtime_llm` turn detection). Input audio for a missing VAD or STT is now discarded instead of buffered for the whole session, and a VAD or STT added later with `Agent.updateOptions` no longer receives that stale audio.
