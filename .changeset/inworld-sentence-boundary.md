---
'@livekit/agents-plugin-inworld': patch
---

Stream text to Inworld as it arrives on `inworld-tts-2` models and let the server split it at sentence boundaries, lowering time to first audio. Pass a `tokenizer` to keep client-side sentence splitting. `bufferCharThreshold` now defaults to 250 and is sent with server-side splitting only when set.
