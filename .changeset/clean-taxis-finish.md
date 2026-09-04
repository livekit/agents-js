---
'@livekit/agents': patch
---

Add an `onSessionEnd` lifecycle callback and configurable timeout before internal session report cleanup. Flush final OTEL logs after shutdown callbacks with a bounded timeout. Apply Python's connection, total, and retry policy to session report uploads.

Wait for session report cleanup before applying the process shutdown timeout, force-stop jobs that exceed memory limits, preserve logs queued during a final flush, and keep cleanup details and session metadata safe for logging.

Honour `LIVEKIT_OBSERVABILITY_URL` when resolving the observability endpoint, keeping the override's scheme, port, and base path so a plaintext or non-default-port collector is reachable, and warn once when that endpoint is plaintext.

The telemetry exporters now take `observabilityUrl` (a full base URL) in place of `cloudHostname` (a bare host that always implied https). `cloudHostname` is deprecated but still accepted on `setupCloudTracer`, `uploadSessionReport`, `SimpleOTLPHttpLogExporterConfig`, and `PinoCloudExporterConfig`, and resolves to the same endpoint as before.
