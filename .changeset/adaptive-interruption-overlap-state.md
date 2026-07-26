---
'@livekit/agents': patch
---

fix(interruption): keep adaptive interruption armed when agent speech restarts mid-overlap

`overlapSpeechStarted` is the gate that lets a user's overlapping audio reach the interruption
model, and only a VAD start-of-speech raises it. Two events cleared it while the user was still
talking, and because VAD never re-announces speech that is already under way, nothing could re-arm
it for the rest of the agent turn: every remaining frame was dropped, no inference request was
made, and the agent talked straight through the interruption.

- A transport failover rebuilt `InterruptionStreamBase` from scratch and replayed only
  `agent-speech-started`, which marks the agent as speaking but leaves the overlap disarmed. The
  in-progress overlap is now handed to the replacement stream.
- A second speech segment in the same turn (a queued `SpeechHandle`, or the reply after a tool
  call) raises `agent-speech-started` again with no `agent-speech-ended` in between, and was
  treated as a new turn. An open overlap is now preserved across it; a genuine new turn still
  resets the overlap, audio buffer, cache and counters.

Also stops a rejected forwarding task from surfacing as an unhandled rejection during the failover
backoff.
