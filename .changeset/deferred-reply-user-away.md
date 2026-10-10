---
'@livekit/agents': patch
---

Treat an `away` user as inactive in `AgentActivity.waitForInactive`, so `userAwayTimeout` no longer blocks the activity's idle wait. A user who went quiet after `userAwayTimeout` kept the wait loop spinning on `delay(0)`, and the deferred result of a non-blocking tool (`ToolExecutor.deliverReply`, which awaits `waitForIdle()`) was never spoken. Only a `speaking` user holds the activity busy now, which matches the Python `wait_for_idle`.
