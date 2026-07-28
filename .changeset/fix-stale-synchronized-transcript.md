---
'@livekit/agents': patch
---

fix(voice): stop the agent transcript from running one reply behind after an interruption

Once a user interrupted the agent, the transcript could permanently desynchronize from the
audio: every later reply was reported, committed to the chat context, and rendered to the
user with the _previous_ reply's text while the new reply was the one actually being spoken.
The lag was one turn and it never recovered for the remainder of the session — asked for a
story and then for the weather, the agent would speak the weather answer while the transcript
still showed the story. Late in a session the reported text degraded further, to empty.

The trigger is an interrupted reply whose playback-finished event arrives before its text
forwarding flushes, which is the ordinary ordering on a barge-in. The flush then lands on the
freshly rotated segment, and the next reply's first text chunk mistakes that empty segment for
one whose playback finish is still in flight and queues it. Nothing ever settles that entry on
its own, so from then on each reply's real playback finish is consumed to settle the segment
queued a turn earlier, and its transcript is what gets reported. A segment is now only queued
when it genuinely still owes a playback finish — it carried audio downstream and has not been
marked finished — so a segment that owes nothing can no longer displace the current one.
