---
'@livekit/agents': patch
---

Drain accepted session responses and ordered events before shutdown, cancel expired remote runs, and surface transport send failures. Add `RemoteSession.waitForReady()` to retry startup pings.
