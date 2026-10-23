---
'@livekit/agents-plugin-google': patch
---

Hold input transcription that arrives while a blocking tool call is pending and hand it to the agent as the user's turn when the tool result goes out, instead of starting a generation for it: that generation interrupted the tool call's turn, and the agent waited for it to play before sending the tool result, so the session hung. `gemini-3.8-live` can deliver a turn's transcript after the tool call it made.
