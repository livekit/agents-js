---
'@livekit/agents': minor
---

Require OpenTelemetry JS SDK 2.x and experimental packages 0.2xx. Migrate resources to
`resourceFromAttributes`, configure processors with `spanProcessors`, and pass
`registerSpanProcessor` when using a custom tracer provider.
