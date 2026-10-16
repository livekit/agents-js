---
'@livekit/agents': patch
---

Fix a crash when a session recording upload fails while reading the response, such as on a socket reset. Also retry the same DNS and connection errors as the Python SDK, such as `EPIPE` and `EAI_FAIL`.
