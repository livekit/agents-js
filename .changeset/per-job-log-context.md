---
'@livekit/agents': minor
---

Add per-job context to the global Pino logger for session-level log filtering

The global logger now automatically includes `jobId` and `roomName` on every log line during an active job. This makes it possible to filter all SDK-internal logs (TTS/STT metrics, speech events, AgentSession lifecycle) by job in log aggregation tools like NewRelic, Datadog, or Grafana.

Context is set when a job starts and cleared after shutdown callbacks complete.
