---
'@livekit/agents-plugin-google': patch
---

Stop reporting the model's own generations as user speech while a `NON_BLOCKING` tool call is pending, so the call's result is no longer cancelled before it reaches the model.
