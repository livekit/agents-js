---
'@livekit/agents': patch
---

Type `language_hint` on the inference `DeepgramOptions`, so a `deepgram/nova-3` caller can set `modelOptions: { language_hint: ['en', 'es'] }` without a type error, and widen `DeepgramFluxOptions.language_hint` to `string | string[]` for parity with the other providers. No wire change from the typing: the plugin already spreads `modelOptions` into the session's `extra`.

The plugin now also drops a `language_hint` its provider cannot apply, instead of sending one the gateway silently ignores. Deepgram applies the hint only in Nova-3 multi language mode, so on a non-Flux Deepgram model with any other language (or no language at all) the hint is removed from the session's `extra` and a warning names the option, the model and the language; the caller's own options are left alone. `deepgram/flux-*` models keep the hint under any language, since the Flux provider forwards it, and the hint still reaches Deepgram only while the gateway's `deepgram_stt_language_hint` flag is open.
