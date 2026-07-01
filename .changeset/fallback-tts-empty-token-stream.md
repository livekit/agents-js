---
'@livekit/agents': patch
---

Prevent `FallbackAdapter` from marking the primary TTS unavailable and cascading through the fallback chain when the LLM emits a turn with zero text tokens (e.g. a tool-only turn). The empty audio response is the correct result when nothing was sent to synthesize, so it is now treated as a clean no-op exit instead of a silent provider failure.
