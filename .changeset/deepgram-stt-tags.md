---
'@livekit/agents-plugin-deepgram': patch
---

Support Deepgram usage tags on the v1 `STT` through a new `tags` option, sent as repeated `tag` query params on both streaming and prerecorded requests, matching `STTv2`.
