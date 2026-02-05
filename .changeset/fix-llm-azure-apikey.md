---
"@livekit/agents-plugin-openai": patch
---

fix(openai): skip apiKey check when client is provided in LLM and TTS constructors

When using `LLM.withAzure()` or passing a custom client to `TTS`, the constructors were incorrectly requiring `OPENAI_API_KEY` even though a client was already provided. This fix skips the apiKey validation when a custom client is passed, matching the behavior fixed in RealtimeModel (PR #339).
