---
'@livekit/agents': patch
---

Bound the speech scheduler's wait on an interrupted generation and force-abort the reply tasks on timeout, so a reply interrupted before its playout starts no longer wedges `mainTask` and mutes the agent for the rest of the session.
