---
'@livekit/agents': patch
---

Make `mergeFrames` linear instead of quadratic. It previously rebuilt the accumulated buffer with a boxed spread on every frame (`new Int16Array([...data, ...frame.data])`), costing O(total_samples x frame_count) copies. It now sums lengths in one pass and copies each frame once into a preallocated `Int16Array`. Merging a 30s utterance of 10ms frames drops from ~60s of blocked event loop to under a millisecond; callers include the Silero VAD inference loop, STT plugin `recognize` paths, and TTS `ChunkedStream.collect()`.
