---
'@livekit/agents': patch
---

chore(deps): bump `@livekit/protocol` to `^1.46.3`

Picks up new agent-session messages: `CustomEvent`, `AgentSessionEvent.custom_event` (livekit/protocol#1588), `AgentSessionEvent.FunctionToolsStarted`, `AgentSessionEvent.EotPrediction`, and `SessionRequest.UpdateIO`. No runtime behavior change in `@livekit/agents` itself — this only makes the new types available for downstream consumers.
