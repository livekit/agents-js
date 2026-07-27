---
'@livekit/agents': patch
---

Allow failed inference avatar provisioning to be retried safely without duplicate provider sessions or cleanup callbacks, fall back to the connected room SID when dispatch metadata omits it, refresh gateway authentication across retries, and preserve the avatar audio output in RoomIO so synchronized transcription and avatar playback share the same output.
