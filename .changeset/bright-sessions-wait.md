---
'@livekit/agents': patch
---

Drain accepted session responses and ordered events before shutdown, cancel expired remote runs, and surface transport send failures. Add `RemoteSession.waitForReady()` to retry startup pings.

Cancel pending transcription reads and join reply cleanup while preserving interrupted text. Release Room stream writers after cancelled sends and close TCP connections on oversized frames.
