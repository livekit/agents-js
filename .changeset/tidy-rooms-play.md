---
'@livekit/agents': patch
---

Exclude discarded room audio from reported playback duration. The room audio queue now defaults
to 200ms, matching Python. Set `RoomOutputOptions.queueSizeMs` to retain a larger prebuffer for
bursty TTS output.
