---
'@livekit/agents': patch
---

Fix a playback-segment counter imbalance that hangs the agent (silent until the participant disconnects) after a barge-in. Two related fixes:

- `ParticipantAudioOutput.captureFrame` bumped `playbackSegmentsCount` (via `super.captureFrame`) **before** its pause/interrupt gate. A frame captured while paused and then interrupted bailed at the gate after that bump, stranding the segment count ahead of `playbackFinishedCount` so the next `waitForPlayout()` blocked forever. The count is now taken only after the gate. (#1662)

- `SyncedAudioOutput` (the `TranscriptionSynchronizer` wrapper) counts a segment in its own `captureFrame`, then forwards to the downstream sink — which can drop the frame at its interrupt gate without counting or ever finishing it. Because the wrapper's finish count is driven by the downstream's playback-finished events, its segment count drifts permanently ahead and its `waitForPlayout()` — awaited by the reply pipeline before it marks generation done — strands forever, freezing the turn pump. `SyncedAudioOutput.waitForPlayout()` now reconciles that drift (emitting the missing finishes for segments the downstream dropped) before waiting; the downstream's legitimate in-flight segments are still awaited.
