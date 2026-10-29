---
'@livekit/agents-plugin-google': minor
---

Bump `@google/genai` to `^2.31.0`, default `gemini-3.8-live` models to `NON_BLOCKING` tool behavior while keeping `pushAudio` open, omit Gemini API `willContinue` frames on Vertex AI, add mid-session `sendContextUpdate` support for instructions and tools on Vertex AI `gemini-3.8-live` with session-resumption handle guards, enable Vertex AI `gemini-3.8-live` `FunctionResponse.scheduling`, and expose `labels` in `RealtimeModel` options.
