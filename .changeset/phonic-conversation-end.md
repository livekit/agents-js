---
'@livekit/agents-plugin-phonic': patch
---

End the agent session cleanly when Phonic ends the conversation: the assistant ending it or the time limit closes the session without an error, and a no-input timeout is reported as a typed `PhonicNoInputTimeoutError`.
