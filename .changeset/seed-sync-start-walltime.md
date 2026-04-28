---
"@livekit/agents": minor
---

Port livekit/agents#5511 + #5532:

- **feat(avatar): add `lk.playback_started` RPC support to `DataStreamAudioOutput`** — new `waitPlaybackStart` constructor option (default `false`). When `true`, the `playbackStarted` event is deferred until the remote avatar worker invokes the `lk.playback_started` RPC instead of firing eagerly on the first captured frame.
- **fix/refactor(transcription): drive `SegmentSynchronizerImpl` start-time off `onPlaybackStarted`** — `startWallTime` and `startFuture` are now set when the audio output reports playback start (chained automatically through `SyncedAudioOutput.onPlaybackStarted`), rather than when the first audio frame is pushed. Combined with the close-path fallback from #5532 this keeps the synchronizer correct for both eager (room) and deferred (avatar RPC) playback timing.

Note: only the consumer side (the agent registering the RPC handler and surfacing the event) is included; agents-js does not have an `AvatarRunner` / `DataStreamAudioReceiver`, so the producer-side `notifyPlaybackStarted` is skipped.
