---
'@livekit/agents': patch
---

Resolve a failed local turn-detector prediction to 1.0, and skip the executor when the native binding is missing, so turns commit after `minDelay` instead of waiting for the maximum delay.
