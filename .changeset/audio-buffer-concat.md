---
'@livekit/agents': patch
---

Avoid spreading typed arrays into plain arrays when concatenating audio in `AudioByteStream.write` and `mergeFrames`. Both now copy with `TypedArray.set`, which removes per-sample allocations on the audio path and reduces CPU spikes and event-loop stalls under load.
