---
'@livekit/agents': patch
---

Keep the synchronized transcript of a reply cut off by a forced interrupt or session close when the audio output reports playback finished just after `clearBuffer()`, instead of committing the full generation.
