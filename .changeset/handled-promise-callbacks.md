---
'@livekit/agents': patch
'@livekit/agents-plugin-silero': patch
---

Handle rejected promises in agent shutdown and room state updates. Close Silero VAD output and release its resampler when inference fails.
