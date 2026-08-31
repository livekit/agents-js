---
'@livekit/agents': minor
---

Add an `onSessionEnd` lifecycle callback and configurable timeout before internal session report cleanup. Flush final OTEL logs after shutdown callbacks with a bounded timeout. Apply Python's connection, total, and retry policy to session report uploads.

Coordinate worker shutdown with session-end completion, bound registered shutdown callbacks, preserve logs queued during a final flush, and keep cleanup failure details safe for logging.
