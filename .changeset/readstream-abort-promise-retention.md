---
'@livekit/agents': patch
---

Fix `readStream()` retaining every chunk until its abort signal fires: racing `reader.read()` against a single long-lived `waitForAbort` promise accumulated one promise reaction (holding that iteration's chunk) per read, pinning every inbound AudioFrame for the lifetime of STT pipelines (#2046).
