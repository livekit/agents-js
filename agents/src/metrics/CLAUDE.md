# CLAUDE.md

Per-model/provider usage tracking and aggregation for billing and analytics.

## Key Components

- **ModelUsageCollector** — Aggregates metrics by `provider:model` key. Handles both standard LLM metrics and RealtimeModel metrics (with token detail breakdowns: text, image, audio, cached).
- **Usage types**: `LLMModelUsage`, `TTSModelUsage`, `STTModelUsage`, `InterruptionModelUsage` — each with provider-specific fields.
- **`filterZeroValues()`** — Strips zero-valued fields from usage objects for clean JSON output.

## Non-Obvious Patterns

- **Session duration tracking**: Some models (xAI) bill by session duration rather than tokens — tracked in `sessionDurationMs`.
- **UsageCollector is deprecated** — use `ModelUsageCollector` instead.
