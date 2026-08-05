---
'@livekit/agents': patch
---

Commit realtime tool call outputs to the agent chat context. Previously the realtime path only sent them to the provider and to `session.history`, leaving `agent.chatCtx` with function calls that had no matching outputs — which broke action-aware history summarization and agent handoff merges.
