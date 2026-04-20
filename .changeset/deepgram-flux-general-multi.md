---
'@livekit/agents-plugin-deepgram': minor
'@livekit/agents': minor
---

Add Deepgram `flux-general-multi` STTv2 model support with multi-language detection. Introduces a new `languageHint` option for biasing the model toward specific languages (only used by `flux-general-multi`), and adds a new `sourceLanguages` field on `SpeechData` that carries all detected languages sorted by prevalence. For multi-language detection, the dominant language is set on `language` while `sourceLanguages` retains the full list.
