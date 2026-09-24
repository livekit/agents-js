---
'@livekit/agents': patch
---

Support adaptive interruption for STT providers without aligned word timestamps.
Release an active false-interruption pause when a tool calls `disallowInterruptions()`.
