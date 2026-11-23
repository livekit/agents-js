---
'@livekit/agents': patch
---

Honour the LiveKit Inference TTS error frame: read its `code` (string or number) and `data` fields, falling back to `message` when `data` is empty, for the error message and stop retrying when LiveKit Inference marks the error `retryable: false` (`retryable: null` counts as retryable).
