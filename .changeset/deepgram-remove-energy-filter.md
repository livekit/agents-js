---
'@livekit/agents-plugin-deepgram': patch
---

Send all audio frames to Deepgram instead of filtering quiet frames locally, preserving silence for endpointing and keeping provider timestamps aligned with the input audio. Usage now includes the previously filtered audio.
