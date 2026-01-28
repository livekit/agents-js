---
'@livekit/agents': patch
---

Implement health check

Change the health check from always returning healthy to returning the status of the following two criteria:
- agent is connected to livekit server
- agent's inference executor is running
