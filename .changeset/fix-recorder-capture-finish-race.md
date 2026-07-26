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

A finish reported by the wrapped output settles its segment whether or not the recorder has been
flushed. The `AudioOutput` contract lets a sink report a finish as soon as its playout ends, and
`TranscriptionSynchronizer` does exactly that when it reconciles a dropped segment from
`waitForPlayout`, so requiring a flush first would strand the caller.

`waitForPlayout` no longer depends on a flush either. A segment the wrapped output never counted
is settled once that output reports its own playout complete, since at that point no finish can
ever arrive for it. Waiting for a flush instead only worked because `performAudioForwarding` — the
one thing that captures frames — happens to flush in a `finally`; a caller that waited without
flushing hung forever.

Behavior change: `waitForPlayout` now blocks while a frame is still in flight inside the wrapped
output. Previously it could return immediately with a fabricated
`{ playbackPosition: 0, interrupted: false }`, reporting a turn as completed while its audio had
not been handed to the sink yet. Callers that relied on the early return will now wait for the
real playback result.
