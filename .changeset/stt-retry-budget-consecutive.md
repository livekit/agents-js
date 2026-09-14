---
'@livekit/agents': patch
---

Reset the STT retry budget once a connection attempt outlived the connect timeout, so an idle socket recycled by the provider (Cartesia's `1001 Idle timeout` every ~3 minutes on a silent caller) no longer exhausts `maxRetry` and ends the session.
