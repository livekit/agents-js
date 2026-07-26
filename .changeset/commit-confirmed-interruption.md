---
'@livekit/agents': patch
---

Commit a confirmed interruption instead of leaving it resumable

When adaptive interruption ruled an overlap a genuine barge-in, `onInterruption` only
parked the speech through `interruptByAudioActivity`, leaving the false-interruption
timer free to put the interrupted audio back on the wire once its timeout elapsed. That
timer exists for overlaps nobody has ruled on yet, so a confirmed verdict now ends the
pause outright. This also stops the agent roughly 700ms sooner, since committing the
interruption no longer waits for the final transcript to arrive.
