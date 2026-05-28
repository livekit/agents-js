---
'@livekit/agents-plugin-google': patch
---

feat(google): lift realtime API out of beta

The Google Realtime API is now available at `google.realtime` (e.g. `google.realtime.RealtimeModel`). The previous `google.beta.realtime` path is still re-exported for backward compatibility but is deprecated and will be removed in a future release.
