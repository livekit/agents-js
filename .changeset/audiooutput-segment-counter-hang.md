---
'@livekit/agents': patch
---

Fix ParticipantAudioOutput stranding its playback-segment counter when a frame is interrupted while paused. `captureFrame` registered the segment (via `super.captureFrame`) before the pause/interrupt gate, so a frame that bailed at the gate left `playbackSegmentsCount` ahead of `playbackFinishedCount` forever — every subsequent `waitForPlayout()` then blocked, which could hang the agent's main loop (the stalled turn is never interrupted, so `mainTask` parks on `_waitForGeneration()`). The segment is now counted only after the gate is cleared.
