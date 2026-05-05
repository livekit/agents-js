---
'@livekit/agents': minor
---

`voice.AMD`: full parity port from python `livekit/agents` `voice/amd/{classifier,detector}.py`.

- `llm` and `stt` options now accept `LLM | string | null` and `STT | string | null` respectively. Strings are resolved to Cloud Inference clients (`'google/gemini-3.1-flash-lite-preview'` LLM, `'cartesia/ink-whisper'` STT by default), instances are caller-owned, `null` opts out (LLM falls back to `session.llm`; STT falls back to session-level `UserInputTranscribed` events).
- AMD now binds to a participant via `participantIdentity` and defers `noSpeechTimer` until that participant's audio track is published *and* subscribed (`waitForTrackPublication({ waitForSubscription: true })`). `detectionTimeoutMs` still applies as a hard ceiling from `execute()` start.
- AMD owns a private STT pump that tees a fresh branch off `AudioRecognition` (`AudioRecognition.subscribeAudioStream()`), pushes audio into the dedicated STT, and ingests `FINAL_TRANSCRIPT`s tagged `'amd_stt'`. Session-level transcripts are ignored when a dedicated STT is configured (source filtering parity).
- `AMDResult` gains `speechDurationMs` and `delayMs` (lk.amd.speech_duration / lk.amd.delay span attributes) for telemetry parity. Span `transcript` attribute moves to `lk.amd.transcript`.
- `aclose()` now cancels any in-flight LLM stream and closes AMD-owned LLM/STT instances (caller-owned instances are left alone).
- `AgentSession.amd` getter and internal `_setAmd` registration mirror python `session._amd`.
- `clearTimer('silence')` only clears the trigger when a live timer was actually pending (Python parity).
- Drops the JS-only `maxTranscriptTurns` option; UNCERTAIN responses now always wait for `detectionTimeoutMs` like python.
- `waitForTrackPublication` gains a `waitForSubscription?: boolean` option that resolves only after the matching publication is subscribed.
- `examples/src/telephony_amd.ts` now demonstrates both inbound and SIP-outbound flows (gated on `LIVEKIT_OUTBOUND_TRUNK_ID`, `SIP_PHONE_NUMBER`, `SIP_PARTICIPANT_IDENTITY` env vars), mirroring python `examples/telephony/amd.py`. It calls `room_io.set_participant` before AMD, hangs up on shutdown via `RoomServiceClient.deleteRoom`, and routes `MACHINE_VM` results into a voicemail message.
