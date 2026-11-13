---
'@livekit/agents-plugin-google': patch
---

Hold input transcription that arrives while a blocking tool call is pending and hand it to the agent as the user's turn when the tool result goes out, instead of starting a generation for it: that generation interrupted the tool call's turn, and the agent waited for it to play before sending the tool result, so the session hung. `gemini-3.8-live` can deliver a turn's transcript after the tool call it made. If the connection drops while the call is pending, the held text is handed over before the session reconnects, so the new connection replays it.
