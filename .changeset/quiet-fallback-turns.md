---
'@livekit/agents': patch
---

Keep TTS fallback providers available when synthesis is cancelled or the input is empty or whitespace-only. Close active provider streams on cancellation, preserve the serving provider's trace attribution after partial audio, and preserve prompt failover when a provider fails while text is still arriving.
