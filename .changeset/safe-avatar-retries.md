---
'@livekit/agents': patch
---

Allow failed inference avatar provisioning to be retried safely without duplicate provider sessions or cleanup callbacks, and preserve the avatar audio output in RoomIO so synchronized transcription and avatar playback share the same output.
