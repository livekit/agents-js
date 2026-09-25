---
'@livekit/agents': patch
---

Prewarm the LLM, STT and TTS when an agent activity starts or resumes, like the Python framework does, so the first reply after a handoff does not pay for the provider handshake. Adds a no-op `prewarm()` to the base `TTS` and `STT` classes for providers to override.
