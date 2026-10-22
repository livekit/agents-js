---
'@livekit/agents': patch
---

Watch an async tool's deferred reply as a `Task`, so `session.run()` settles after the reply instead of hanging on `handle.addDoneCallback is not a function`.
