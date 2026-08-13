---
'@livekit/agents': patch
---

Commit completed tool outputs before starting the post-tool reply so overlapping turns cannot reuse stale preemptive generations. Preserve tool completion timestamps, pair tool-error outputs with their calls, and normalize unparseable call arguments before saving them.
