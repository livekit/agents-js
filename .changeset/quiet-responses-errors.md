---
'@livekit/agents-plugin-openai': patch
---

Retry a failed OpenAI Responses request under a `FallbackAdapter`: the Responses LLM no longer re-emits an `error` event that nobody listens to on it, which threw out of the retry loop.
