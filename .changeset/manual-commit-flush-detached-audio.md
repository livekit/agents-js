---
'@livekit/agents': patch
---

Flush the STT with silence when `commitUserTurn()` runs with input audio disabled, and track the STT sample rate from forwarded frames, so a manual (push-to-talk) commit holds the complete final transcript instead of a clipped interim one.
