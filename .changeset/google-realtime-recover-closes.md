---
'@livekit/agents-plugin-google': patch
---

Reconnect a Gemini Live session the server drops, the way the Python plugin does, instead of ending it on the first abnormal close. A close during setup is retried instead of hanging, a context-exhausted close (1007) still ends the session, and running out of retries emits a final error instead of an unhandled rejection.
