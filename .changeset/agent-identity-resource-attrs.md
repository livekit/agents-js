---
'@livekit/agents': patch
---

Include agent identity in telemetry resource attributes: stamp `lk.agent_name` when the job carries an agent name, and honor `OTEL_RESOURCE_ATTRIBUTES` (via the standard env detector) so environment-provided resource attributes reach cloud tracing.
