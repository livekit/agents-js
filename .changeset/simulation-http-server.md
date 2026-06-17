---
'@livekit/agents': patch
---

Simulation fixes: do not start the worker HTTP server, disable the worker load limit so runs can saturate the agent, and honor `LIVEKIT_AGENT_NAME_OVERRIDE` so the worker registers under the name `lk simulate` dispatches to.
