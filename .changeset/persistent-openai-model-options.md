---
'@livekit/agents-plugin-openai': patch
---

Add persistent `modelOptions` to the OpenAI-compatible Chat Completions LLM and provider helpers, allowing provider-specific request defaults on every agent turn. Per-call `extraKwargs` override these defaults while existing typed options retain their precedence.
