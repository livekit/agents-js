---
'@livekit/agents-plugin-google': patch
---

Restart the Gemini Live session after a `goAway` at a gap between turns in the last 30 s of the time the server grants, bounded by its `timeLeft`, instead of immediately: an immediate restart cut the reply being spoken, and on `gemini-3.8-live` the session came back unresponsive.
