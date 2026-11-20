---
'@livekit/agents': patch
---

Forward the generated text as the transcript when a TTS that reports an aligned transcript returns no word timings, for example when a LiveKit Inference server-side fallback serves the turn. A reply that plays to the end now gets its transcript and its assistant message in the chat context.
