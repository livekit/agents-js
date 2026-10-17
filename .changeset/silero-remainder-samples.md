---
'@livekit/agents-plugin-silero': patch
---

Fix the sample count of the carried-over remainder frames in the Silero VAD stream, which could delay inference by a window when input frames are not window-aligned.
