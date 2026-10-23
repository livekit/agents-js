---
'@livekit/agents': patch
'@livekit/agents-plugin-livekit': patch
---

Time out the text turn detector's end-of-turn prediction after 3 seconds like the Python SDK, and fail inference requests once the inference process has exited instead of waiting forever, so the user turn still commits.
