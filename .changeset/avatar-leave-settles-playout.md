---
'@livekit/agents': patch
---

Finish pending avatar playout when the avatar participant leaves the room, so the reply that was playing no longer waits forever and the next reply reaches a replaced `session.output.audio`.
