---
"@livekit/agents": patch
---

fix(voice): surface tool-argument validation errors to the LLM instead of returning a generic "internal error"

When an LLM-generated tool call failed JSON parsing or Zod schema validation, the framework returned `"An internal error occurred"` to the LLM, which left the model with no way to correct itself — causing it to loop on the same invalid call. Argument-validation failures are now wrapped in a `ToolError` whose message includes the tool name and the validator's diagnostic, so the LLM can fix its arguments.

Behavior is unchanged for exceptions thrown from inside a tool's `execute`: regular `Error`s are still masked as `"An internal error occurred"` to avoid leaking server-side details, and `ToolError` continues to be the supported way to forward a custom message to the LLM.
