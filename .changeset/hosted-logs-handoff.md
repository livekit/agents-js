---
'@livekit/agents': patch
---

On LiveKit Cloud, hand log collection to LiveKit Cloud when `LIVEKIT_HOSTED_LOGS=true`, `LIVEKIT_HOSTED_LOGS_HANDOFF_FILE` and `LIVEKIT_HOSTED_LOGS_JOBS_DIR` are set. Each job process writes its output to its own file, and the session's `record` logs and redaction options decide whether that file is collected. Log records are held until that decision and redacted when the project or the session requires it. Pino log lines are no longer exported over OTLP; session reports, transcripts, and traces are unchanged.
