---
'@livekit/agents': patch
---

feat(telemetry): emit `AgentConfigUpdate` chat items in OTLP session logs

Adds an `AgentConfigUpdate` chat item that records changes to the agent's
instructions and tools (additions/removals). The initial agent configuration
and subsequent `updateTools` calls now insert an `AgentConfigUpdate` into both
the agent's and the session's chat context, and the OTLP `chat_history`
exporter serializes these items so config changes are visible alongside the
surrounding conversation. Insertions are skipped when there is no visible
diff (no instructions and no tool diff).

Ports https://github.com/livekit/agents/pull/5601 from the Python repo.
