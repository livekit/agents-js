---
"@livekit/agents-plugin-openai": patch
---

Default OpenAI reasoning effort to `none` for `gpt-5.4-mini`. `*-chat-latest` models no longer send a default `reasoning_effort` (Python parity, and the API only accepts `medium` for them).
