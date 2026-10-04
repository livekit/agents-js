---
'@livekit/agents-plugin-google': patch
---

Send `activityEnd` from `commitAudio()` so manual activity detection can close a user turn without requesting a reply.
