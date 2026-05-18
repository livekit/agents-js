---
'@livekit/agents-plugin-openai': patch
---

fix(openai): map `http://` baseURL to `ws://` (not `wss://`) on WebSocket URLs

The Responses-API LLM (`ws/llm.ts`), realtime STT (`stt.ts`), and
conversational Realtime endpoint (`realtime/realtime_model.ts`) all
build their upgrade URL from `baseURL`, but force-mapped (or only
half-mapped) the scheme to `wss://`. With a plain-HTTP baseURL (e.g.
an in-cluster LiteLLM proxy at `http://litellm:4000`), this produced
a `wss://litellm:4000/...` URL, attempted a TLS handshake against a
non-TLS listener, and failed with `tls_get_more_records:packet length
too long`. The fix maps `http://` → `ws://` and `https://` → `wss://`.
OpenAI's native endpoint is always HTTPS, so this is a no-op for
direct connections.
