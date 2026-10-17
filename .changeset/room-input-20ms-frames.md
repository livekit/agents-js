---
'@livekit/agents': patch
---

Read the room audio input in 20 ms frames when no frame processor or noise cancellation is attached, halving the native frame events per second of caller audio.
