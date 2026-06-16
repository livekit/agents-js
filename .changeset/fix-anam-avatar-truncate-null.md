---
'@livekit/agents': patch
'@livekit/agents-plugin-openai': patch
---

Fix DataStream avatars (Anam, Bey, D-ID, LemonSlice, Runway, Tavus, Trugen) stalling the
conversation on user interruption when paired with the OpenAI Realtime API.

`DataStreamAudioOutput` parsed the `lk.playback_finished` RPC payload with a compile-time-only
`as PlaybackFinishedEvent` cast. The LiveKit avatar protocol serializes that payload with
snake_case keys (`playback_position`, `synchronized_transcript`) — confirmed against Anam's
live engine, which emits `{"playback_position": 2.0, "interrupted": true, "synchronized_transcript": null}`
— so the camelCase `playbackPosition` read back `undefined`. That became
`Math.floor(undefined * 1000) === NaN`, which `JSON.stringify` serializes as `null` in
`conversation.item.truncate`; the OpenAI Realtime API then rejected the truncate with an
`invalid_type` error and the interrupted turn could not recover.

`DataStreamAudioOutput` now normalizes the wire payload (snake_case primary, camelCase
fallback), which also restores the previously-dropped `synchronizedTranscript` on interrupted
turns. As defense-in-depth, the realtime truncate path now clamps a non-finite `audioEndMs` to
a valid non-negative integer in both `AgentActivity` and the OpenAI plugin so a malformed or
absent playback position can never again serialize as `null`.
