---
"@livekit/agents": patch
---

fix(voice): return actual tool error message to the LLM instead of a generic "An internal error occurred"

Previously, when a tool's `execute` function threw a non-`ToolError` exception (or arguments failed schema validation), the framework sent the literal string `"An internal error occurred"` back to the LLM as the tool call output. With no information about what went wrong, the LLM would typically retry the same tool call in a loop. The exception's `message` is now passed through to the LLM so it can correct its arguments or recover gracefully.
