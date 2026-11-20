---
'@livekit/agents': patch
---

Ignore a handoff returned by a tool after the same agent has already started handing off, so overlapping handoff tool calls no longer switch agents twice and repeat onEnter.
