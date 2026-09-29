---
'@livekit/agents': patch
---

Stop the VAD stream from forwarding frames from an attached source after `endInput()`, which
caused an unhandled rejection.
