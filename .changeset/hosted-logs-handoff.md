---
'@livekit/agents': patch
---

When `LIVEKIT_HOSTED_LOGS=true`, create the file at `LIVEKIT_HOSTED_LOGS_HANDOFF_FILE` when `@livekit/agents` loads, and stop exporting pino log lines over OTLP while that file exists. If the file cannot be created, the SDK keeps exporting its logs. Session reports, transcripts, and traces are unchanged.
