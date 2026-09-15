---
'@livekit/agents': patch
---

Telemetry coverage: `lk.interruption.source` and `lk.playout.position` on `agent_turn`, an `update_agent` span grouping agent handoffs, fallback adapters reporting the instance that serves (`lk.fallback.label`/`index`, response model on the request and node spans), and a `keyterm_detection` span for the keyterm-detection LLM pass.
