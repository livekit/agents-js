---
'@livekit/agents-plugin-deepgram': patch
---

Stop sending the `languageHint` that Deepgram rejects, and add it where it applies.

`STTv2` (Flux) warned that `languageHint` was ignored for any model but `flux-general-multi`, then sent it anyway on the live config; Deepgram answers that with a 400, so the session failed. The hint is now removed from the options, both when the instance is built and on a later `updateOptions`, and one warning says it was removed.

`STT` (the `/v1/listen` plugin, which serves `nova-3` with `language: 'multi'`) gains `languageHint`, forwarded as a repeated `language_hint` query parameter. Deepgram applies the parameter only in Nova-3 multi language mode, so it is sent only when the session language is `multi`; any other language drops it and warns once.
