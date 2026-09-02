---
'@livekit/agents-plugin-phonic': patch
---

Implement `updateOptions()` on the Phonic realtime model/session (previously a no-op) to change config fields mid-session (e.g. `defaultLanguage`, `voice`, `boostedKeywords`, no-input-poke settings). The change is applied immediately via a Phonic `reset`, so it can be called around a task advance — e.g. `model.updateOptions({ defaultLanguage: 'es' })` — to switch the language for the next reply. `toolChoice` (the base param) is accepted but not supported by Phonic. When the default language changes (and `additionalLanguages` isn't set), the previous default is rotated into `additionalLanguages` so the overall language set stays intact.
