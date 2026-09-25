---
'@livekit/agents': patch
---

Stop retrying a LiveKit Inference STT error that the gateway marks `retryable: false`, such as a language the model does not support. The stream used to reconnect into the same refusal.
