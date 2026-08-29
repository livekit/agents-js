---
'@livekit/agents': patch
---

RoomIO now preserves a pre-set `session.input.audio` and `session.output.transcription` instead of silently replacing them, matching the existing behavior for `session.output.audio` and the python implementation.
