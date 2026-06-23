---
'@livekit/agents': patch
---

Pipeline nodes (`ttsNode`, `sttNode`, `transcriptionNode`, `realtimeAudioOutputNode`) now accept an async generator/iterable as their stream input end-to-end. This includes the static `Agent.default.*` helpers and the `Agent.create()` / `AgentTask.create()` hook overrides, so overrides can pass a generator directly to `voice.Agent.default.<node>(ctx.agent, generator, settings)` without wrapping it in `toStream()` first. Also fixes a `getReader is not a function` crash when an `Agent.create`/`AgentTask.create` stream hook received a plain `AsyncIterable`.
