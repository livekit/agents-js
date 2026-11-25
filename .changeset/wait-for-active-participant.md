---
'@livekit/agents': patch
---

`waitForParticipant` now waits for a participant to become _active_ rather than merely connected.

A remote participant can only receive data messages once it reaches `ParticipantState.ACTIVE`.
Resolving on `ParticipantConnected` handed back a participant that is present in
`room.remoteParticipants` but not yet reachable, so anything sent to it was silently dropped —
most visibly in `DataStreamAudioOutput`, where avatar audio could be published before the avatar
worker could receive it. This matches the Python SDK's `wait_for_participant`, which has always
waited on `participant_active`.

Requires `@livekit/rtc-node` with `RoomEvent.ParticipantActive` and `Participant.state`.
