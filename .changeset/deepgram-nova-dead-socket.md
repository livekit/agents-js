---
'@livekit/agents-plugin-deepgram': patch
---

Recover the Deepgram Nova streaming STT from a dropped socket without losing the caller's speech: commit the open turn, replay audio Deepgram had not transcribed, reconnect when a turn stalls, and stop retrying after repeated drops without a finished turn.
