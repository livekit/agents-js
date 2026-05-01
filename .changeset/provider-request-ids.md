---
'@livekit/agents': patch
---

feat(telemetry): expose provider request ids on STT/TTS/LLM spans for debugging

Adds the `lk.provider_request_ids` (string[], deduped) span attribute to the
`user_turn` (STT), `tts_request_run` (TTS), and `llm_request_run` (LLM) spans
so users can correlate traces with the provider's server-side logs.
