---
"@livekit/agents": patch
---

Update fallback adapter docstrings to use searchable "Agent Fallback Adapter" / "Inference Fallback Adapter" prefixes so the relevant code is easy to locate from the docs.

- `agents/src/llm/fallback_adapter.ts`, `agents/src/stt/fallback_adapter.ts`, `agents/src/tts/fallback_adapter.ts`: prefix the class docstring with "Agent Fallback Adapter for LLM/STT/TTS".
- `agents/src/inference/stt.ts` (`STTFallbackModel`) and `agents/src/inference/tts.ts` (`TTSFallbackModel`): prefix the typedef docstring with "Inference Fallback Adapter".

Ports https://github.com/livekit/agents/pull/5654 from `livekit/agents`.
