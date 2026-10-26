---
'@livekit/agents-plugin-deepgram': patch
---

Stop sending the `languageHint` that Deepgram rejects, and add it where it applies, without ever discarding the caller's value.

`STTv2` (Flux) warned that `languageHint` was ignored for any model but `flux-general-multi`, then sent it anyway on the live config; Deepgram answers that with a 400, so the session failed. The hint is now kept in the options and left off the connection config for a model that cannot take it, with one warning. Because the value survives, a session that switches back to `flux-general-multi` sends it again, both on an existing stream and on a stream created afterwards; previously the hint was deleted from the instance, so the two disagreed.

`STT` (the `/v1/listen` plugin) gains `languageHint`, forwarded as a repeated `language_hint` query parameter. Deepgram applies the parameter only to `nova-3` / `nova-3-general` in multi language mode, so it is sent only when the session language is `multi` and the model is one of those two; on any other model or language it is kept but not sent, with one warning, and a change back into `multi` sends it again.

`STT` also stops rewriting `nova-3-general` to `nova-2-general` for a non-English language. That entry in the model validator was stale: Deepgram lists `nova-3` and `nova-3-general` on the same multilingual row, and the Python plugin's validator never carried the rule.
