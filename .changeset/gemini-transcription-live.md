---
'@livekit/agents': patch
'@livekit/agents-plugin-google': patch
---

Add Gemini 3.5 Transcribe Live to LiveKit inference and the Google beta plugin.

`stt.SpeechStream` now resets its retry budget after every final transcript, so `maxRetry`
bounds consecutive failures rather than the lifetime of the stream. Providers that recycle
their socket on a fixed interval (such as Gemini Live's 10-minute session cap) previously
exhausted the budget and stopped recognizing on long sessions.
