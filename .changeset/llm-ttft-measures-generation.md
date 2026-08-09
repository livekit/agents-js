---
'@livekit/agents': patch
---

fix(llm): measure ttft against generation, not the first chunk to arrive

The time-to-first-token clock started on whatever chunk arrived first. That was harmless
while a stream went unretryable at its first chunk, because a retry then implied nothing had
arrived. Now that a contentless chunk keeps a stream retryable, the metadata chunk of a
_failed_ attempt starts the clock, and the turn reports a near-zero ttft for a wait that
spanned a stall and a retry — so retried turns read as faster than a normal one rather than
slower.

The clock now starts on generation, in both the metrics monitor and the voice pipeline's
span. A response that generates nothing continues to report `ttftMs` as -1.
