---
'@livekit/agents': patch
---

Scope the audio pause gate to the segment being captured

`ParticipantAudioOutput.clearBuffer()` resolves an `interruptedFuture` that frames parked at
the pause gate consult to decide whether to bail. Nothing reset that signal until the _next_
segment's `flush()`, which only runs after that segment's frames have all been captured — so
for the whole of the following reply the signal still described an interruption that was
already over. If the output was paused mid-reply during that window (an ordinary
false-interruption pause, on by default), every remaining frame bailed at the gate and never
reached the wire. The session still reported the reply as fully spoken and committed it to the
chat context, so the loss was silent: in a reproduction with a real `AgentSession` and a real
`ParticipantAudioOutput`, 18 of 20 frames — 360ms of a 400ms reply — were dropped.

The gate is now scoped to the segment being captured: a frame bails only for an interruption
raised at or after its own segment began. Frames parked at the gate are also woken by a
per-frame signal, so a `flush()` that replaces `interruptedFuture` can no longer strand one
there.

The same snapshot is now consulted on every frame rather than only on frames that parked at a
closed gate. `cancelSpeechPause` un-gates the sink to admit the next reply as soon as the
handle is interrupted, but the interrupted reply's `forwardAudio` loop keeps running until its
abort signal fires an event loop turn later, and real TTS providers hand it several seconds of
audio ahead of realtime to drain in the meantime. Those frames found the gate already open and
took the unchecked path to the wire.
