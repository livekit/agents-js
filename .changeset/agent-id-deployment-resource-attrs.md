---
'@livekit/agents': patch
---

Stamp the hosted-agent identity on the cloud tracing resource: read `LIVEKIT_AGENT_ID` and `LIVEKIT_AGENT_DEPLOYMENT` (set by the LiveKit Cloud launcher) and merge them as `lk.cloud_agent_id` / `lk.deployment_id` so agent insights can attribute telemetry per agent and deployment. Customer-provided `OTEL_RESOURCE_ATTRIBUTES` are preserved; the platform values only override matching keys.
