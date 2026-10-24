---
'@livekit/agents': patch
---

Attach the supervised process 'error' listener right after forking, so a child process that fails to spawn rejects `initialize()` instead of crashing the worker with an unhandled `write EPIPE` error.
