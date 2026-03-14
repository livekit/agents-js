# CLAUDE.md

LiveKit Inference Gateway clients for LLM, STT, and TTS. Provides unified interface over LiveKit's cloud inference service.

## Key Classes

- **LLM** — OpenAI-compatible client pointing at LiveKit Inference Gateway. Dynamic JWT token generation for auth. Supports provider format adapters (OpenAI, Google).
- **STT** — WebSocket-based STT client. Streams audio as base64 frames in 50ms chunks. Supports live model/language switching via reconnect events.
- **TTS** — WebSocket-based TTS client (sibling pattern to STT).

## Non-Obvious Patterns

- **Model strings must be `provider/model` format**: e.g., `'openai/gpt-4o-mini'`, `'deepgram/nova-3'`. Never just `'gpt-4o-mini'`.
- **STT language parsing**: Parses `model:language` from the model string (e.g., `'deepgram/nova-3:en'`).
- **STT fallback chains**: If primary model fails, gateway tries fallback models in order.
- **Zod validation**: All gateway protocol messages validated with Zod schemas in `api_protos.ts`.
- **Google thought_signature**: LLMStream preserves `thoughtSignature` across parallel tool calls in a batch, only resets at end of response.

## Subdirectory

- `interruption/` — Advanced interrupt detection logic (ML-based adaptive detector).
