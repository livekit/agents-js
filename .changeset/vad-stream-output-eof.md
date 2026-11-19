---
'@livekit/agents': patch
'@livekit/agents-plugin-silero': patch
---

End the VAD stream output after `endInput()` so iterating a `VADStream` finishes instead of waiting forever.
