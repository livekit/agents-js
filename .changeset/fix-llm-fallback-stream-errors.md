---
'@livekit/agents': patch
---

Fix LLM fallback errors crossing concurrent requests and outer retries replaying text or tool calls when `retryOnChunkSent` is false. Cancel active child streams when the fallback stream closes.
