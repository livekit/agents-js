---
'@livekit/agents': patch
---

Read the agent name from `[agent] name` in `livekit.toml` when neither the `agentName` option nor `LIVEKIT_AGENT_NAME` sets it, and warn when the name is set in code.
