---
'@livekit/agents': patch
---

Adaptive interruption: stop dropping audio at the send boundary, and make the verdict diagnosable.

The WebSocket transport re-checked `overlapSpeechStarted` immediately before writing to the socket, after awaiting any in-flight reconnect. Because `overlap-speech-ended`, `agent-speech-ended` and `bargein_detected` can all clear that flag inside the await window, audio the pipeline had already committed to sending could be discarded and never counted in `numRequests`. The buffering stage upstream is the only place that decides whether a slice belongs to an overlap, which matches the Python implementation, whose send task gates on nothing.

An overlap that ends without any usable inference result now logs at `warn` (previously `debug`) with the overlap duration, `numRequests`, buffered samples and agent-speech state, so a fallback backchannel verdict is no longer indistinguishable from a genuine low-probability one. Every verdict also logs `probability`, `isInterruption` and `numRequests` at `debug`. `OverlappingSpeechEvent` is now exported by name for typing `overlapping_speech` handlers.
