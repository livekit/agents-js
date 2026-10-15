---
'@livekit/agents-plugin-openai': patch
---

Listen for `error` on the OpenAI Realtime WebSocket while it connects. `ws` emits `error` before `close` when the handshake fails or when the connect timeout's `close()` aborts a still-connecting socket ("WebSocket was closed before the connection was established"); with no listener Node threw it as an unhandled `error` event, which escaped the connect promise and crashed the whole worker process instead of failing that one session.
