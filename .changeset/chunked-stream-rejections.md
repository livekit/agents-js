---
'@livekit/agents': patch
---

Stop failed `tts.ChunkedStream` requests from surfacing as unhandled promise rejections. The failure is already reported through the TTS `error` event.
