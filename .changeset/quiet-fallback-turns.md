---
'@livekit/agents': patch
---

Keep TTS fallback providers available when synthesis is cancelled or the input is empty. Close active provider streams on cancellation, and preserve prompt failover when a provider fails while text is still arriving.
