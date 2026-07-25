---
'@livekit/agents': patch
---

Fix a deadlock where a recorder-wrapped audio output could leave `waitForPlayout` stranded when
an interrupt arrived before the recorder had registered its segment. `RecorderAudioOutput` now
registers its own segment before forwarding a frame downstream, and attributes each playback
finish to the segment it belongs to instead of relying on a global counter.

A recorded segment is also timestamped when it opens rather than when the wrapped output accepts
its first frame, so a finish that lands while that frame is parked no longer clamps the segment's
playback position to zero and drop the audio the sink reported as played. And a segment whose
downstream capture throws now releases the capture latch on both the recorder and the wrapped
output, so a caller that retries after a transient rejection is no longer rejected forever with
`recorder capture has no active segment`.
