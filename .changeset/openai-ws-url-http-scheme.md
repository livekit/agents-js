---
'@livekit/agents-plugin-openai': patch
---

fix(openai): respect `baseURL` scheme when building WebSocket URLs

The Responses-API LLM (`ws/llm.ts`), realtime STT (`stt.ts`), and
conversational Realtime endpoint (`realtime/realtime_model.ts`) all
build their upgrade URL from `baseURL` but either force-mapped
`http://` to `wss://` (LLM) or left `http://` unchanged (STT, Realtime),
producing an invalid WebSocket URL or a spurious TLS handshake against
a plain-HTTP listener. The scheme of `baseURL` is now respected:
`http://` maps to `ws://` and `https://` maps to `wss://`. OpenAI's
native endpoint is HTTPS, so this is a no-op for direct connections.
