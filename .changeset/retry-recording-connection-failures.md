---
'@livekit/agents': patch
---

Retry session recording uploads after DNS, connection, and connection-timeout failures while
keeping total and connection timeouts scoped to the upload request.
