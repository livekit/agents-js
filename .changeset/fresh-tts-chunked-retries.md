---
'@livekit/agents': patch
---

Restart chunked TTS retries with a fresh attempt queue so retried synthesis uses a fresh request ID and does not write to a closed failed-attempt queue.
