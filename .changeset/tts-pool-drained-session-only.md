---
'@livekit/agents': patch
---

fix(inference): only reuse a pooled TTS gateway socket once the session is drained

`inference.TTS` keeps its gateway websockets in a `ConnectionPool` and reuses them across
replies. A run only proves the gateway owes it no more audio when it receives `done`, but a
`session.closed` event mid-reply also returned normally from `SynthesizeStream.run`, which
put the socket back in the pool while the gateway was still mid-synthesis.

The next reply then picked up that socket and read the previous reply's outstanding audio as
its own. In production this surfaced after a barge-in: the interrupted reply's remaining
synthesis (~54s of it) was spoken by the _following_ reply, so the user heard the old answer
continue while the transcript and chat context showed the new one, and the new reply's own
audio was never heard. Nothing in the interruption path could stop it — the audio was
legitimately new output belonging to an un-interrupted speech handle.

The socket is now removed from the pool unless the run saw the gateway's `done`.
