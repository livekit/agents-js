# CLAUDE.md

Speech-to-text abstractions with streaming, VAD-based adapters, and automatic retry.

## Key Classes

- **STT** — Abstract base. Subclasses implement `_recognize()` (one-shot) and `stream()` (streaming). Emits `metrics_collected` and `error` events.
- **SpeechStream** — Async iterable consuming audio frames via `pushFrame()`, yielding `SpeechEvent` objects. Handles audio resampling internally if sample rates don't match.
- **StreamAdapter** — Wraps a non-streaming STT + VAD to create a streaming interface. Buffers audio during speech, calls `recognize()` on end-of-speech.

## Architecture

```
pushFrame() → AudioResampler (if needed) → AsyncIterableQueue → run() (provider impl) → output queue → consumer
```

## Non-Obvious Patterns

- **Dual queue architecture**: Input queue, intermediate queue (for metrics monitoring), and output queue run concurrently.
- **FLUSH_SENTINEL**: Private static symbol signals flush operations internally without creating actual events.
- **startSoon() in constructor**: Defers `mainTask()` until after constructor completes to avoid accessing uninitialized fields.
- **Resampler created on-demand**: Only instantiated when first frame with different sample rate arrives.
- **Retry with exponential backoff**: `mainTask()` retries on `APIError`/`APIConnectionError`; other errors are immediately fatal.
- **startTimeOffset**: Can offset transcription timestamps for stream resumption.
