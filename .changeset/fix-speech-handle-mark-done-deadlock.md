---
'@livekit/agents': patch
---

fix(voice): prevent scheduling deadlock when pipeline task crashes

Move the `_markGenerationDone()` call in `SpeechHandle._markDone()` outside the
`if (!doneFut.done)` guard so a pending generation future is always resolved,
even when `doneFut` was already settled by a prior interrupt / shutdown path.
Previously, the second `_markDone()` short-circuited and left the generation
unresolved, which caused `mainTask` to hang on `_waitForGeneration()` and
starve subsequent speech handles. Ports
[livekit/agents#5678](https://github.com/livekit/agents/pull/5678).
