---
'@livekit/agents-plugin-anam': patch
---

Anam now waits for the avatar's `lk.playback_started` signal, so agent turn state follows when the avatar actually starts speaking. Ported from the Python plugin.
