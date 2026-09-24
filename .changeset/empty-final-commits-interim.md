---
'@livekit/agents': patch
---

Add the `commitInterimOnEmptyFinal` session option, off by default. When an STT provider closes a segment with an empty final after VAD heard speech, it commits the buffered interim text instead of leaving the user turn open until the user speaks again.
