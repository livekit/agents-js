---
'@livekit/agents-plugin-cartesia': patch
---

fix(cartesia): surface TTS websocket server errors

Cartesia error frames over the synthesis WebSocket are now classified by
`status_code`: 5xx raises a retryable `APIStatusError` (carrying the status
code) so the base `SynthesizeStream` retries and emits `tts_error` once retries
are exhausted, while 4xx (e.g. empty-transcript on function-call turns) is
logged at debug and the segment finishes cleanly.
