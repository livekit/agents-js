---
'@livekit/agents': patch
---

Run a typed `run_input` turn (text simulations, `lk console` text mode) as a spoken turn: emit the final `user_input_transcribed` and call `onUserTurnCompleted` before the reply.
