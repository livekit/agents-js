---
'@livekit/agents': patch
---

Commit the buffered interim transcript when an STT provider closes a segment with an empty final after VAD heard speech, instead of leaving the user turn open until the user speaks again.
