# CLAUDE.md

Text-to-speech abstractions with streaming, chunked synthesis, stream adapters, and multi-provider fallback.

## Key Classes

- **TTS** — Abstract base. Subclasses implement `synthesize()` (one-shot) and `stream()` (streaming).
- **SynthesizeStream** — Push text via `pushText()`, yields `SynthesizedAudio`. Tracks metrics per segment (separated by `flush()`).
- **ChunkedStream** — One-shot synthesis from fixed text. `collect()` aggregates all frames.
- **StreamAdapter** — Wraps non-streaming TTS using `SentenceTokenizer`. Synthesizes sentences independently with task-based concurrency (each task waits for previous to complete).
- **FallbackAdapter** — Multi-provider failover with background health monitoring and automatic recovery.

## Non-Obvious Patterns

- **Two sentinels**: `FLUSH_SENTINEL` marks segment boundaries (for per-segment metrics), `END_OF_STREAM` marks input completion.
- **Segment-based metrics**: Each segment between flushes gets independent TTFB, duration, and token tracking.
- **Timed transcripts on frames**: Word-level timing stored in `frame.userdata[USERDATA_TIMED_TRANSCRIPT]` for avatar lip-sync. Not all providers support this.
- **FallbackAdapter resampling**: Uses highest sample rate across all providers. Per-stream resampler to avoid concurrency issues.
- **Mid-utterance fallback impossible**: If audio already pushed during streaming, can't switch providers (would break audio continuity). Throws error instead.
- **Silent failure detection**: If synthesis completes but no audio received, throws `APIConnectionError` to trigger fallback.
- **Lazy metrics task**: `monitorMetrics()` only starts on first text push, not in constructor.
- **Output close deferred**: Output queue stays open until metrics monitoring completes, ensuring all frames are consumed.
