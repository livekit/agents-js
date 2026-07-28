---
'@livekit/agents': patch
---

fix(voice): release the audio pause a finished speech was still holding

When the user's audio activity pauses the agent mid-reply, the activity records which speech
the pause belongs to so the false-interruption timer can resume that same speech if the
overlap turns out to be a backchannel. That record was never cleared when the speech itself
finished, so it outlived its owner: the audio sink stayed gated, and the next thing to read
the record — a later VAD blip arming the resume timer — acted on a speech that was already
over. That produced a spurious `agent_false_interruption` event for a completed reply and left
the sink paused, which any subsequent resume then un-gates without first signalling an
interruption.

The scheduling loop now drops the paused-speech record, cancels the false-interruption timer,
and resumes the audio output as soon as the paused speech's generation completes, matching
the Python implementation's `_scheduling_task`.
