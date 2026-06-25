---
'@livekit/agents': patch
---

Emit the `lk.chat_ctx` span attribute (on LLM-generation and EOU-prediction spans) in snake_case to match the Python framework, which serializes the same attribute via `chat_ctx.to_dict()`. The JS side was stringifying `chatCtx.toJSON()` directly, which emits camelCase field names (`callId`, `args`, `isError`, `createdAt`), so traces from JS agents diverged from Python agents. The chat context is now run through the shared `toSnakeCaseDeep` conversion (exported from the report layer), and the timestamp exclusion is aligned with Python (`toJSON()` defaults exclude image/audio/timestamps). Note: the Python EOU path additionally trims to the last N turns and excludes function calls — aligning that behavior is left to a follow-up.
