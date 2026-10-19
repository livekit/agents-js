---
'@livekit/agents-plugin-rime': patch
---

WebSocket v1 now requires `modelId` when constructing `TTS`. If your configuration relied
on a model in the URL path, add `modelId` explicitly.

Custom endpoint paths pass through without model detection or path restrictions. The
examples use `coda.api.rime.ai` and `mist.api.rime.ai`.
