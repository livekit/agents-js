---
'@livekit/agents-plugin-phonic': patch
---

Preserve tool call outputs across mid-session resets. livekit core commits realtime `function_call` items to the agent chat context but not their `function_call_output`, so on a handoff/reset the Phonic plugin rebuilt the conversation history with tool calls but no outputs. The plugin now remembers the outputs it observes and re-injects them into the reset history.
