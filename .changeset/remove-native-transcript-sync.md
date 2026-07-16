---
'@livekit/agents-plugin-phonic': patch
'@livekit/agents': patch
---

Remove the unused `nativeTranscriptSync` realtime model capability. No model relies on native transcript synchronization anymore (Phonic switched to `stream_ahead_of_real_time` mode), so the transcription synchronizer is always enabled.
