---
'@livekit/agents-plugin-openai': patch
'@livekit/agents': patch
---

Preserve web-search calls and annotated messages in Responses metadata over HTTP and WebSocket, including messages with a null phase. Add an include option for requesting full sources in standard agent sessions. Avoid retrying a response after search output has reached the application, and honor retryOnChunkSent for that output in the fallback adapter.
