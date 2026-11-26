---
'@livekit/agents': patch
---

Avoid retaining resolved stream values and listeners on `AbortSignal` in `readStream` and `AudioRecognition.createInterruptionTask` (#2658).
