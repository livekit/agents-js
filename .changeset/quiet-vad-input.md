---
'@livekit/agents': patch
---

Fix `VADStream.endInput()` so it closes input after buffered frames instead of leaving a rejected promise.
