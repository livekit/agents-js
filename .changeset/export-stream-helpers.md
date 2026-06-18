---
'@livekit/agents': patch
---

Document and publicly export the `readStream` and `toStream` stream helpers. `readStream` consumes a `ReadableStream` as an abortable async generator, and `toStream` adapts an `AsyncIterable` into a `ReadableStream`. Both are now surfaced under the `stream` namespace alongside the other stream utilities and carry full TSDoc describing their abort/cancel semantics.
