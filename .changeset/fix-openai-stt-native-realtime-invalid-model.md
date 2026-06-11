---
'@livekit/agents-plugin-openai': patch
---

Fix `openai` realtime STT (transcription session) failing on every model
with `invalid_request_error.invalid_model` when connecting directly to
`wss://api.openai.com/.../realtime`.

OpenAI's native endpoint now treats a `?model=` query param on the
WebSocket upgrade URL as selecting a conversation session, so the
subsequent transcription-mode `session.update` is rejected — surfacing
as `invalid_model` and a `4000` close. Drop the `?model=` parameter
when the host is `api.openai.com` (the model is conveyed via
`session.update → audio.input.transcription.model` instead).

OpenAI-compatible proxies (LiteLLM, Cloudflare AI Gateway, etc.) still
receive the model on the upgrade URL so they can route by model before
the first frame, preserving the original intent of #1467.
