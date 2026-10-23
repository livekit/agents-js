---
'@livekit/agents-plugin-deepgram': patch
---

Stop sending the `languageHint` that Deepgram rejects, and add it where it applies.

`STTv2` (Flux) warned that `languageHint` was ignored for any model but `flux-general-multi`, then sent it anyway on the live config; Deepgram answers that with a 400, so the session failed. The hint is now removed from the options, both when the instance is built and on a later `updateOptions`, and one warning says it was removed.

`STT` (the `/v1/listen` plugin) gains `languageHint`, forwarded as a repeated `language_hint` query parameter. Deepgram applies the parameter only to `nova-3` / `nova-3-general` in multi language mode, so it is sent only when the session language is `multi` and the model is one of those two; any other model or language drops it with one warning.

`STT` also stops rewriting `nova-3-general` to `nova-2-general` for a non-English language. That entry in the model validator was stale: Deepgram lists `nova-3` and `nova-3-general` on the same multilingual row, and the Python plugin's validator never carried the rule.
