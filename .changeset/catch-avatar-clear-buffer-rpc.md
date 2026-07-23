---
'@livekit/agents': patch
---

Prevent rejected avatar clear-buffer RPCs from emitting unhandled rejections or stranding
playout waiters.
