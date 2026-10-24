---
'@livekit/agents': patch
---

Stop decoding in `audioFramesFromFile` once the consumer cancels the stream, and stop its channel writes from surfacing as unhandled rejections (e.g. when `BackgroundAudioPlayer` stops a clip early).
