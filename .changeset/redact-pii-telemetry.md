---
'@livekit/agents': patch
---

Tag content-bearing telemetry with `lk.pii.*` and redact trace exception details when job redaction is enabled. Dashboards and queries using the previous sensitive trace keys must migrate to their `lk.pii.*` replacements.
