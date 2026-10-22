---
'@livekit/agents': patch
---

Reject idle waits when their activity closes so pending foreground callbacks cannot run during shutdown or handoff.
