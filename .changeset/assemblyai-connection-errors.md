---
'@livekit/agents-plugin-assemblyai': patch
---

Report connection failures and unexpected WebSocket closures as API errors. Preserve the error type when the plugin's retries run out so the SDK can recover the STT stream.
