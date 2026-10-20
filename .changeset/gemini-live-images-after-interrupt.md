---
'@livekit/agents-plugin-google': patch
---

Send a user turn that carries images as content after `interrupt()`, instead of as realtime text: as realtime text its words reached Gemini ahead of the images and were answered without them.
