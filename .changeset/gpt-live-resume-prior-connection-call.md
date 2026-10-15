---
'@livekit/agents-plugin-openai': patch
---

Continue GPT-Live's backend from tool results of calls made on an earlier connection, so a tool that awaits an AgentTask (or finishes after a reconnect) no longer stops the backend's tool chain.
