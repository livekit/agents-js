---
'@livekit/agents': patch
---

`clearUserTurn()` now cancels a pending `commitUserTurn()`, so a stale commit can no longer fire
inside the next manual turn and drop that turn's transcript.
