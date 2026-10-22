---
'@livekit/agents-plugin-deepgram': patch
---

Stop sending the `languageHint` that Deepgram rejects, and add it where it applies.

`STTv2` (Flux) warned that `languageHint` was ignored for any model but `flux-general-multi`, then sent it anyway on the live config; Deepgram answers that with a 400, so the session failed. The hint is now removed from the options, both when the instance is built and on a later `updateOptions`, and one warning says it was removed.

`STT` (the `/v1/listen` plugin) gains `languageHint`, forwarded as a repeated `language_hint` query parameter. Deepgram applies the parameter only to `nova-3` / `nova-3-general` in multi language mode, so it is sent only when the session language is `multi` and the model is one of those two; any other model or language drops it with one warning. The plugin's existing model validator rewrites `nova-3-general` under `multi` to `nova-2-general`, so until that rule is lifted the hint applies to `model: 'nova-3'`.
