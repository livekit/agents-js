---
'@livekit/agents': patch
'@livekit/agents-plugin-google': patch
---

Report reasoning tokens in usage metrics. `CompletionUsage`, `LLMMetrics` and `RealtimeModelMetrics` gain a `reasoningTokens` field, aggregated into `LLMModelUsage.outputReasoningTokens` and emitted as the `gen_ai.usage.reasoning*` span attributes — matching how the Python framework exposes them.

The Gemini Live plugin now maps `usageMetadata.thoughtsTokenCount` onto that field. Gemini counts thinking tokens inside `responseTokenCount`, so `reasoningTokens` is reported alongside `outputTokens` rather than added to it, and is left `undefined` when the provider omits it — a reported zero stays distinguishable from a missing count without deriving it from `totalTokens - inputTokens - outputTokens`.
