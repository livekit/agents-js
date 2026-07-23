---
'@livekit/agents': patch
---

Add `Agent.updateOptions()` for swapping STT, VAD, LLM, and TTS models at runtime, including
explicit `null` values to disable session fallback.
