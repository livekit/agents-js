---
'@livekit/agents': patch
---

fix(room-io): ownership-aware FrameProcessor lifecycle management in `ParticipantAudioInputStream`. Introduces a `processorOwned` flag and an internal `updateProcessor()` helper that only closes the previous processor when the stream owns it, so an externally-provided `FrameProcessor` survives track transitions and is only closed on `close()`. Ported from Python PR [livekit/agents#5467](https://github.com/livekit/agents/pull/5467).
