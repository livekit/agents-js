---
'@livekit/agents-plugin-google': patch
---

Add a `sessionResumption` option to the Gemini Live `RealtimeModel`. It defaults to `true`, which keeps today's behaviour. With `false`, every reconnect opens a fresh session without a resumption handle and the plugin replays the chat context instead. On `gemini-3.8-live` a resumed session kept seeded history less reliably than a fresh one.
