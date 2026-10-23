---
'@livekit/agents': patch
---

When LiveKit Cloud runs a log sidecar next to a hosted agent (`LIVEKIT_HOSTED_LOGS=sidecar` and `LIVEKIT_HOSTED_LOGS_HANDOFF_FILE`), create the hand-off file at worker start and stop exporting pino log lines over OTLP, so the sidecar ships the agent's stdout instead. If the file cannot be created, the SDK keeps exporting its logs. Session reports, transcripts, and traces are unchanged.
