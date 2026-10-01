---
'@livekit/agents': patch
---

Tag the destination identity in avatar clear-buffer failure logs as PII.
Expose `telemetry.traceTypes.ATTR_DESTINATION_IDENTITY` for the shared log key.
