---
'@livekit/agents': patch
---

Remove the abort listener `waitForOrAbort` adds once its race settles, so `waitForIdle` and `ctx.filler` no longer pile listeners on the activity's close signal.
