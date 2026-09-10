---
'@livekit/agents': patch
---

Wait for agent task handoffs during session shutdown, including concurrent agent updates, without leaking activities or waiting on the task's own tool. Preserve transfer errors, suppress tool replies during shutdown, and make warm-transfer room-disconnect failures explicit.
