---
'@livekit/agents': patch
---

Bound the native `dispose()` in the process job executor with a timeout so a job child always reaches `process.exit(0)`. Previously, if native FFI disposal hung on a handle that never drained, the child would never exit and would linger indefinitely holding the job's full RSS while still answering supervisor pings (so it was never reclaimed by the orphan reaper).
