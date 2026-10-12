---
'@livekit/agents-plugin-google': patch
---

With manual activity detection, hold user audio between activities and send it once one opens, and open an activity on `interrupt()` only while a reply is running: audio streamed before the activity opened cut the first words of a turn, and an activity without speech was transcribed as a stray user turn.
