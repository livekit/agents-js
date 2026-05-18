---
'@livekit/agents-plugin-cartesia': patch
---

fix(cartesia): surface TTS websocket server errors

Cartesia error frames over the synthesis WebSocket now raise a retryable
`APIConnectionError`, so the base `SynthesizeStream` retries and emits
`tts_error` once retries are exhausted. Empty/whitespace input on
function-call turns — where Cartesia returns an error frame with
`done: true` — is treated as completion to match the Python plugin.
