---
'@livekit/agents': patch
---

Finish a reply interrupted while the audio output is paused at once, instead of after the 2 s cancel timeout (5 s for resampled TTS audio and `say()`). `AudioOutput.captureFrame` accepts an optional `{ signal }`, which outputs that wrap another output should pass on.
