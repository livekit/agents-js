---
'@livekit/agents': patch
---

Stop a confirmed interruption from resuming the interrupted speech

Two defects let audio the model had already ruled a genuine barge-in get back on the wire.

`cancelSpeechPause` un-gated the audio sink without first signalling the interruption to it.
Frames of the speech it had just interrupted were parked at the sink's pause gate, so opening
that gate — meant only to admit the next speech — released them and the interrupted speech
continued from exactly where it stopped. The interruption is now signalled before the gate
opens, so those frames are dropped.

`onInterruption` also only parked the speech through `interruptByAudioActivity`, leaving the
false-interruption timer free to resume it once its timeout elapsed. That timer exists for
overlaps nobody has ruled on yet, so a confirmed verdict now ends the pause outright. This
also stops the agent roughly 700ms sooner, since committing the interruption no longer waits
for the final transcript to arrive.
