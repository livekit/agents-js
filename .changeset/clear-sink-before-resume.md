---
'@livekit/agents': patch
---

Signal the interruption before un-gating the audio sink

`cancelSpeechPause()` reopened the sink's pause gate to admit the next speech, but the frames
parked at that gate belong to the speech it had just interrupted, and they are released first — so
audio the user has already barged in over reached the wire. Python gets the ordering for free by
blocking until the interrupted generation finishes; here that await is raced against the interrupt
(#1124) and returns before the reply task has run its own `clearBuffer()`. Clear the sink first
instead.
