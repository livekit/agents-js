---
'@livekit/agents-plugin-soniox': patch
---

Support Soniox stt-rt-v5 and endpointSensitivity. The default STT model is now `stt-rt-v5` and the default `maxEndpointDelayMs` is now `2000` (was `500`); pass `model: 'stt-rt-v4'` / `maxEndpointDelayMs: 500` to keep the previous behavior.
