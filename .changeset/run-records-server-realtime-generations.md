---
'@livekit/agents': patch
---

Record realtime generations the server starts on its own (an auto-continuing model answering a tool result, or the reply after a handoff) in the active `RunResult`, so `session.run()` no longer returns without the handed-off agent's first words.
