---
'@livekit/agents-plugin-google': patch
---

With manual activity detection, hold user audio between activities and send all of it once one opens, and open an activity on `interrupt()` only while a reply is running: audio streamed before the activity opened cut the first words of a turn, and an activity without speech was transcribed as a stray user turn. `commitAudio()` sends the last partial 50 ms chunk with its turn, and `clearAudio()` drops it.
