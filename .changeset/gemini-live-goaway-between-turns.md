---
'@livekit/agents-plugin-google': patch
---

Restart the Gemini Live session between turns after a `goAway`, bounded by the server's `timeLeft`, instead of immediately: an immediate restart cut the reply being spoken, and on `gemini-3.8-live` the session came back unresponsive.
