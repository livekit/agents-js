---
'@livekit/agents': patch
---

Preserve custom OpenTelemetry tracer providers when LiveKit Cloud tracing is enabled, and support sharing an OpenTelemetry 2.x provider with LiveKit Cloud via the `registerSpanProcessor` and `createCloudSpanProcessor` options of `setTracerProvider`.
