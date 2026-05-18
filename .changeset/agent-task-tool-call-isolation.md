---
'@livekit/agents': patch
---

Stop silently dropping LLM tool calls inside and after an `AgentTask` spawned from a function tool.

The `toolChoice='none'` default for `generateReply` (and the matching circular-wait check on `SpeechHandle.waitForPlayout`) now reads the owning function call from the current `Task`'s per-task activity info instead of from `AsyncLocalStorage`. `AsyncLocalStorage` propagates through `await`, so a tool that called `task.run()` was leaking its function-call context into the sub-task's audio-recognition loops — every subsequent `generateReply` defaulted to `toolChoice='none'` and the LLM's tool calls were dropped for the rest of the session. This matches the Python reference implementation, which uses `asyncio.current_task()` plus per-task info for the same check.

Fixes [#1264](https://github.com/livekit/agents-js/issues/1264).
