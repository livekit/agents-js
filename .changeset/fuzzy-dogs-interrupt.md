---
'@livekit/agents': patch
---

Support adaptive interruption for STT providers without aligned word timestamps.
Release an active false-interruption pause when a tool calls `disallowInterruptions()`.
Restore the paused speech's agent state before resuming audio.
Enable adaptive interruption during realtime playback after the initial backchannel boundary.
