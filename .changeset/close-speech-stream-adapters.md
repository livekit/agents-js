---
'@livekit/agents': patch
---

Close temporary speech stream adapters when their owning pipeline or fallback lifecycle ends.
Keep TTS cancellation from marking providers unavailable, and propagate synthesis failures to TTS node consumers.
