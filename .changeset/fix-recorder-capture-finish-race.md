---
'@livekit/agents': patch
---

Fix a deadlock where a recorder-wrapped audio output could leave `waitForPlayout` stranded when
an interrupt arrived before the recorder had registered its segment. `RecorderAudioOutput` now
registers its own segment before forwarding a frame downstream, and attributes each playback
finish to the segment it belongs to instead of relying on a global counter.
