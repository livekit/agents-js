---
'@livekit/agents': patch
---

Fix LLM fallback errors crossing concurrent requests and outer retries replaying text or tool calls when `retryOnChunkSent` is false. Cancel active child streams when the fallback stream closes.

After output, retryable provider errors are wrapped in a non-retryable `APIError` with the original error as `cause`. API error constructors now accept `cause`.
