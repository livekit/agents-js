---
'@livekit/agents': patch
---

`SupervisedProc.initialize()` now fails fast — racing the first IPC message against child exit and the initialize timeout — instead of hanging forever when the child process dies before responding (e.g. an inference runner whose model files are missing). Callers that previously deadlocked (worker startup, console mode) now get an actionable error.
