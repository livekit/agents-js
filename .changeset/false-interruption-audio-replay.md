---
'@livekit/agents': patch
---

fix(room_io): stop dropping audio on false interruptions

`ParticipantAudioOutput.pause()` cleared the entire native `AudioSource` queue, permanently discarding up to `queueSizeMs` (rtc-node default: 1000ms) of generated-but-unplayed audio. On a false interruption (pause then resume) those frames were never replayed, so agent speech was lost mid-sentence from both the live call and the observability recording. The output now keeps a rolling window of recently pushed frames, captures the unplayed tail on pause, and replays it on resume, while still discarding it on a real interruption (`clearBuffer()`).

Behavioral change: the room audio output now defaults `queueSizeMs` to 200ms (matching Python), down from the rtc-node `AudioSource` default of 1000ms, to keep the playout queue close to realtime. Bursty TTS providers that previously relied on the larger prebuffer can pass an explicit `queueSizeMs` via `RoomOutputOptions`.
