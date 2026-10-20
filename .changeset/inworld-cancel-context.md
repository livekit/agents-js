---
'@livekit/agents-plugin-inworld': patch
---

Inworld TTS cancels the server-side context when a stream is closed before the reply finishes, so text not yet synthesized is discarded.
