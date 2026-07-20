---
'@livekit/agents': patch
---

End uncommitted `user_turn` spans when audio recognition closes so speech detected without a transcript is still exported to observability.
