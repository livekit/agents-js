---
'@livekit/agents': patch
---

fix(voice): stop RecorderIO from dropping the final agent speech at session teardown. A force-interrupted shutdown marks the current speech done before playout settles, so the recorder could close and fence out the in-flight playbackFinished flush, silently losing the last agent turn and trailing mic audio from the recording. RecorderIO.close() now waits (bounded) for the pending playback event — which carries the authoritative playback position — before fencing, flushes any input captured since the last write, and warns if unflushed agent audio had to be dropped.
