---
'@livekit/agents': patch
---

Forward the generated text as the transcript when a TTS that reports an aligned transcript returns no word timings, for example when a LiveKit Inference server-side fallback serves the turn. The reply is no longer left without a transcript or an assistant message in the chat context.
