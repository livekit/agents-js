---
'@livekit/agents': patch
---

Stop a rotated-out segment's playback finish from handing its transcript to the next reply's
playout wait, which committed the previous reply's text to chat context as a phantom repeat.
