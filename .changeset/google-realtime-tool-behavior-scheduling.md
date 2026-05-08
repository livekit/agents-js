---
'@livekit/agents-plugin-google': patch
---

feat(google realtime): expose `toolBehavior` and `toolResponseScheduling` options on the Gemini Live `RealtimeModel` and `RealtimeSession`. `toolBehavior` controls whether function calls are blocking or non-blocking (`Behavior.BLOCKING` / `Behavior.NON_BLOCKING`), and `toolResponseScheduling` controls how tool responses are scheduled into the conversation (`SILENT` / `WHEN_IDLE` / `INTERRUPT`). Note that `toolResponseScheduling` is only supported by the Gemini API, not Vertex AI. Ports livekit/agents#3482.
