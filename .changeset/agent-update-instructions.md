---
'@livekit/agents': patch
'@livekit/agents-plugin-openai': patch
---

Add `Agent.updateInstructions()` to update an agent's instructions mid-session (parity with Python). The change propagates the new instructions through the active `AgentActivity`, records an `AgentConfigUpdate` in the chat and session history, and syncs the realtime/stateless contexts. For OpenAI realtime, per-response instructions now preserve the session-level instructions instead of replacing them.
