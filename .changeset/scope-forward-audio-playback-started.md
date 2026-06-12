---
'@livekit/agents': patch
---

fix(voice): scope forwardAudio's playback-started listener to its own segment

When a speech is interrupted, the scheduling loop immediately authorizes the next
speech, so the new segment's `forwardAudio` registers its `playback_started`
listener on the shared audio output while the interrupted segment is still
emitting events during teardown. The stray event resolved the new segment's
`firstFrameFut` before its first frame was captured, which skipped resampler
creation and pushed an unresampled frame straight to the `AudioSource`
(`RtcError: sample_rate and num_channels don't match`) and corrupted playback
bookkeeping. The listener now only resolves `firstFrameFut` after the segment has
captured its own first frame.
