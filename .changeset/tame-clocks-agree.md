---
'@livekit/agents': patch
---

stamp a tool call's `createdAt` when its execution begins rather than when it was parsed off the model stream, so it no longer sorts ahead of the assistant message that requested it
