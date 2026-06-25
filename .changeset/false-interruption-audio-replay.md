---
'@livekit/agents': patch
---

fix(room_io): stop dropping audio on false interruptions

`ParticipantAudioOutput.pause()` cleared the entire native `AudioSource` queue, permanently discarding up to `queueSizeMs` (rtc-node default: 1000ms) of generated-but-unplayed audio. On a false interruption (pause then resume) those frames were never replayed, so up to ~1s of agent speech was lost mid-sentence from both the live call and the observability recording. The output now keeps a rolling window of recently pushed frames, captures the unplayed tail on pause, and replays it on resume, while still discarding it on a real interruption (`clearBuffer()`).
