---
'@livekit/agents-plugin-inworld': patch
---

Create the Inworld TTS context when the first sentence is ready instead of when the stream starts, and skip it entirely for streams with no text.
