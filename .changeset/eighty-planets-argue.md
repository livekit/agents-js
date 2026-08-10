---
'@livekit/agents': patch
'@livekit/agents-plugin-silero': patch
---

fix(vad): copy the speech buffer when emitting START_OF_SPEECH/END_OF_SPEECH frames instead of aliasing it — the pre-roll slide that runs right after END_OF_SPEECH was overwriting the head of the just-emitted frame with the segment's tail, so batch STT (via StreamAdapter) received the end of the utterance prepended to it and transcribed duplicated speech (e.g. "Hello?" → "Hello? Hello?")
