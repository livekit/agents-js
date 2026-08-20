---
'@livekit/agents': patch
---

Add `Agent.updateOptions()` for swapping STT, VAD, LLM, and TTS models at runtime, including
explicit `null` values to disable session fallback, and allow expressive TTS settings to be
updated dynamically on agents and sessions. Only the fields you pass are changed, matching
`Agent.update_options()` in the Python framework.
