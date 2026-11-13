---
'@livekit/agents': patch
---

Skip audio content in the Google provider format instead of sending the raw samples to Gemini as JSON text, matching the Python formatter, and base the dummy user turn on the last turn sent so an audio only last message still ends on a user turn.
