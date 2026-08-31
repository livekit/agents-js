---
'@livekit/agents': patch
---

Add an `onSessionEnd` lifecycle callback and configurable timeout before internal session report cleanup. Flush final OTEL logs after shutdown callbacks with a bounded timeout. Apply Python's connection, total, and retry policy to session report uploads.

Wait for session report cleanup before applying the process shutdown timeout, force-stop jobs that exceed memory limits, preserve logs queued during a final flush, and keep cleanup details and session metadata safe for logging.
