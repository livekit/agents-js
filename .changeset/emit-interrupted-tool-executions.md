---
'@livekit/agents': patch
---

Emit `function_tools_executed` for tool calls that finished before a speech interruption. Both the realtime and pipeline tool-execution paths `return` on `speechHandle.interrupted` ahead of their normal emit site, so a tool whose output landed just before a self-interrupt (e.g. Phonic's self-interrupting multi-step cascade) had its result dropped from observability even though it executed. The event is now emitted from the interrupted branches as well — before the in-flight tool execution is cancelled, so only genuinely-completed outputs are reported. This is observability-only and does not change conversation flow: interrupted turns still skip the tool reply, chat-context update, and agent handoff.
