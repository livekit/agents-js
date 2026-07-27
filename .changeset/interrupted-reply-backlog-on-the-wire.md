---
'@livekit/agents': patch
---

Stop an interrupted reply's TTS backlog from reaching the wire

`captureFrame` only compared a segment's interrupt snapshot while the pause gate was closed, so
the check was skipped entirely once the gate reopened. `cancelSpeechPause` un-gates the sink to
admit the next reply as soon as the handle is interrupted, but the interrupted reply's
`forwardAudio` loop keeps running until its abort signal fires an event loop turn later — and real
TTS providers hand it several seconds of audio ahead of realtime to drain in the meantime. Those
frames took the open-gate path straight to the wire, so the user kept hearing the barged-over
speech resume while the next reply's transcript was already streaming.
