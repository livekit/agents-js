---
'@livekit/agents': patch
---

Make adaptive interruption actually interrupt

Three defects, each of which on its own could leave a barge-in unheard or un-acted-on.

**The overlap gate could be disarmed mid-interruption.** `overlapSpeechStarted` is what lets a
user's overlapping audio reach the interruption model, and only a VAD start-of-speech raises it.
Because VAD never re-announces speech already under way, anything that cleared the flag mid-overlap
disarmed the detector for the rest of the agent turn: every remaining frame was dropped, no
inference request was made, and the agent talked straight through the user. Two events did that. A
second speech segment in the same turn (a queued `SpeechHandle`, or the reply after a tool call)
raises `agent-speech-started` again with no `agent-speech-ended` in between, and was treated as a
new turn; an open overlap is now preserved across it, while a genuine new turn still resets the
overlap, audio buffer, cache and counters. And a transport failover rebuilt
`InterruptionStreamBase` from scratch and replayed only `agent-speech-started`, which marks the
agent as speaking but leaves the overlap disarmed; the in-progress overlap is now handed to the
replacement stream through a distinct `agent-speech-resumed` sentinel. A rejected forwarding task
also no longer surfaces as an unhandled rejection during the failover backoff.

**A confirmed interruption stayed resumable.** When the model ruled an overlap a genuine barge-in,
`onInterruption` only parked the speech through `interruptByAudioActivity`, leaving the
false-interruption timer free to put the interrupted audio back on the wire once its timeout
elapsed. That timer exists for overlaps nobody has ruled on yet, so a confirmed verdict now ends
the pause outright. This also stops the agent roughly 700ms sooner, since committing the
interruption no longer waits for the final transcript to arrive.

**A finished interruption silently discarded the next reply.**
`ParticipantAudioOutput.clearBuffer()` resolves an `interruptedFuture` that frames parked at the
pause gate consult to decide whether to bail. Nothing reset that signal until the _next_ segment's
`flush()`, which only runs after that segment's frames have all been captured — so for the whole of
the following reply the signal still described an interruption that was already over. If the output
was paused mid-reply during that window (an ordinary false-interruption pause, on by default),
every remaining frame bailed at the gate and never reached the wire, while the session still
reported the reply as fully spoken and committed it to the chat context. The gate is now scoped to
the segment being captured: a frame bails only for an interruption raised at or after its own
segment began, and parked frames are woken by a per-frame signal so a concurrent `flush()` can no
longer strand one there.

`OverlappingSpeechEvent` is also now exported by name from `voice/events.js`, so
`overlapping_speech` handlers can be typed without reaching into `inference/interruption/types.js`.
