---
'@livekit/agents': patch
---

Support `onUserTurnExceeded` as an `Agent.create()` / `AgentTask.create()` hook, in addition to the existing subclass override. The callback is now gated on scheduling-paused / new-turns-blocked (start guard plus a post-wait re-check) to match the Python reference, so it is skipped during agent handoffs.
