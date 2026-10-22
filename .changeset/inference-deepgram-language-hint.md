---
'@livekit/agents': patch
---

Type `language_hint` on the inference `DeepgramOptions`, so a `deepgram/nova-3` caller can set `modelOptions: { language_hint: ['en', 'es'] }` without a type error, and widen `DeepgramFluxOptions.language_hint` to `string | string[]` for parity with the other providers. No wire change: the plugin already spreads `modelOptions` into the session's `extra`. The gateway forwards the hint to Deepgram only in Nova-3 multi language mode (``language: 'multi'``) and while its `deepgram_stt_language_hint` flag is open; until then it drops the key.
