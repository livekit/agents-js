---
'@livekit/agents-plugin-deepgram': patch
---

Recover Deepgram Flux streaming STT after unexpected WebSocket closes by surfacing them as retryable connection errors, and preserve the transcript timebase across the reconnect so timestamps stay monotonic.
