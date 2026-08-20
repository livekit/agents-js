---
'@livekit/agents': minor
'@livekit/agents-plugin-deepgram': minor
'@livekit/agents-plugin-minimax': minor
---

Tag content-bearing telemetry with `lk.pii.*` and redact trace exception details when project or session redaction is enabled. Redacted audio uploads now require transcript uploads, Deepgram parse failures retain readable details without logging connection query parameters, and MiniMax task failure payloads no longer appear in exception messages. Dashboards and queries using the previous sensitive trace keys must migrate to their `lk.pii.*` replacements.
