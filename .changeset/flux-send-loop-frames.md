---
'@livekit/agents-plugin-deepgram': patch
---

Fix the Flux (`STTv2`) send loop keeping every audio frame in memory until the next reconnect, and dropping a frame that arrives just after a reconnect request.
