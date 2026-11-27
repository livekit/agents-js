---
'@livekit/agents-plugin-openai': patch
---

Send `temperature: 0` to the Chat Completions API instead of dropping it. A truthiness check treated 0 as unset, so the request silently fell back to the provider default.
