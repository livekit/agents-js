---
'@livekit/agents': patch
---

Fix `VADStream.endInput()` throwing "WritableStream is locked", which surfaced as an unhandled
rejection when an inference STT stream ended its input.
