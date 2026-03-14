# CLAUDE.md

Bridges LiveKit rooms with agent audio/text I/O.

## Key Classes

- **RoomIO** — Central facade. Connects a LiveKit Room to an AgentSession. Creates and wires audio input, audio output, and transcription outputs. Call `start()` to initialize, `setParticipant(id)` to switch which remote participant is being listened to.
- **ParticipantAudioInputStream** — Subscribes to remote participant's microphone track. Auto-resamples. Supports noise cancellation frame processors. Re-subscribes if track is unpublished (tries next available audio track).
- **ParticipantAudioOutput** — Publishes a `LocalAudioTrack` to the room. Tracks pushed duration and emits `EVENT_PLAYBACK_STARTED`/`EVENT_PLAYBACK_FINISHED` with interruption flags.
- **ParticipantTranscriptionOutput** — Modern text streaming via `room.localParticipant.streamText()`.
- **ParticipantLegacyTranscriptionOutput** — Backward-compat via `room.localParticipant.publishTranscription()`.
- **ParallelTextOutput** — Multiplexer forwarding to both modern and legacy implementations simultaneously.

## Non-Obvious Patterns

- **Future-based init**: Two futures coordinate startup — `roomConnectedFuture` and `participantAvailableFuture`. Audio subscription only begins after both resolve.
- **Participant skip logic**: Skips participants with `lk.publish_on_behalf` attribute matching local participant (these are agents publishing on behalf of users). Respects `participantKinds` whitelist.
- **Close-on-disconnect is conditional**: Only `CLIENT_INITIATED`, `ROOM_DELETED`, `USER_REJECTED` trigger auto-close. Network loss / timeout do NOT close — allows reconnection.
- **Race condition in transcript forwarding**: `await` on `captureText()` is critical to prevent out-of-order text segments. Stream writer must be closed BEFORE cancelling the reader task to prevent deadlock.
- **Agent state published to room**: Listens to `AgentStateChanged` and sets `lk.agent.state` attribute on local participant.
- **Dual transcription**: Both modern and legacy implementations publish simultaneously for backward compatibility.
- **Delta vs non-delta modes**: User transcriptions use non-delta (fire-and-forget). Agent transcriptions use delta (continuous streaming with reused writer).
- **startedFuture on audio output**: `captureFrame()` waits until track is actually subscribed before buffering, preventing buffer buildup before listeners exist.
