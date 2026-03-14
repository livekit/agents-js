# CLAUDE.md

Low-level async stream composition primitives built on the Web Streams API (`ReadableStream`, `WritableStream`, `TransformStream`).

## Key Classes

- **StreamChannel<T, E>** — Bidirectional stream: write to it, read from it. `addStreamInput()` launches async reader loops to pipe external streams in.
- **DeferredReadableStream<T>** — Readable stream where the actual source is set later via `setSource()`. Supports detach/reattach.
- **MultiInputStream<T>** — Fan-in multiplexer: N dynamic inputs → 1 output. Inputs can be added/removed at runtime. Output stays open after all inputs end (waits for new inputs).
- **IdentityTransform<T>** — Pass-through `TransformStream` with `highWaterMark` set to `MAX_SAFE_INTEGER` to prevent backpressure.
- **mergeReadableStreams()** — Functional merge of N streams (adapted from Deno). If one errors, merged output closes.

## Non-Obvious Patterns

- **IdentityTransform high water mark**: Intentionally disables backpressure on both sides. This follows the Python agents `channel.py` pattern — needed for concurrent sources.
- **Reader lock cleanup**: TypeErrors from releasing already-released locks are caught and ignored throughout. This is intentional.
- **MultiInputStream resilience**: Errors in one input don't kill the output stream. Failed inputs are removed silently.
