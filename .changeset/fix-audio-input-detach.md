---
'@livekit/agents': patch
---

Fix `session.input.setAudioEnabled(false)` not stopping caller audio

`AudioInput.onDetached()` was a no-op, so room microphone frames kept flowing into STT while a warm-transfer caller was on hold. Held-caller speech could reach the consult agent activity and invoke transfer tools prematurely. Frames are now dropped while detached and resume after re-attach, matching the Python participant input behavior.
