---
"@livekit/agents": patch
---

fix(voice/transcription): seed `startWallTime` in `SegmentSynchronizerImpl.close()` before resolving `startFuture` so `mainTask` does not throw when `markPlaybackFinished` has flipped `playbackCompleted=true` before any audio frame arrived. Port of python #5532.
