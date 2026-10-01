---
'@livekit/agents': patch
---

Fix STT recovery when the session has no error listener or its listener throws. Close the session on provider failures that cannot be retried, and log unexpected STT pipeline failures.
