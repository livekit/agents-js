---
'@livekit/agents': patch
---

Skip the 500 ms wait for a final transcript in `commitUserTurn()` when there is no STT, so a manual commit with a realtime model ends the turn right away.
