---
'@livekit/agents': patch
---

When using the `LLM.withAzure` method, the `apiKey` is redundant, but we need to set it to bypass the LLM's default apiKey check
