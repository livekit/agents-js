---
'@livekit/agents-plugin-phonic': patch
'@livekit/agents': patch
---

Deprecate the `nativeTranscriptSync` realtime model capability while preserving its existing transcript synchronization behavior for third-party models. Remove Phonic's redundant explicit opt-out now that it uses `stream_ahead_of_real_time` mode.
