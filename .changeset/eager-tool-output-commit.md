---
'@livekit/agents': patch
---

Commit completed tool outputs before starting the post-tool reply so overlapping turns cannot reuse stale preemptive generations.
