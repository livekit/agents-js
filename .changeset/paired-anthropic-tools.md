---
'@livekit/agents-plugin-anthropic': patch
---

Drop unpaired `function_call` / `function_call_output` items when building the Anthropic context, and put `tool_result` blocks first in their user message, so a chat context with a tool still running (e.g. on `FallbackAdapter` failover) no longer gets a 400.
