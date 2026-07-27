---
'@livekit/agents': patch
---

fix(voice): stop an interrupted reply from muting the session forever

A reply interrupted before its audio started playing could leave its pipeline reply task
parked in the post-interrupt `waitForPlayout()`, which races only the reply's own abort
signal — a signal nothing on the ordinary interrupt path ever fires. The speech scheduling
loop waits on that reply's generation, so `_currentSpeech` stayed pinned on the interrupted
handle and every later turn was queued but never authorized: the agent went silent for the
rest of the session. On the evidence so far this needs an audio sink whose playback-finished
event the pipeline does not produce itself — remote avatar outputs (`DataStreamAudioOutput`
and the avatar plugins built on it) and user-supplied `AudioOutput`s; a plain room output
settled both of the affected waits on its own across six live runs.

`SpeechHandle` now arms a 5s watchdog when a speech is interrupted (a port of python's
`INTERRUPTION_TIMEOUT`): if the speech has not finished by then, its tasks are cancelled —
firing exactly the abort signal those waits are already watching — and the handle is marked
done, releasing the scheduler.

Fixes #2065.
