---
'@livekit/agents': patch
---

Honour the LiveKit Inference TTS error frame: read its `code` and `data` fields for the error message and stop retrying when the gateway marks the error `retryable: false`.
