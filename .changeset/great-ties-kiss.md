---
'@livekit/agents': patch
---

Reject idle waits with `AbortError` when session shutdown starts or their activity closes so pending foreground callbacks cannot run during shutdown or handoff.
