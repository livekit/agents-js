---
"@livekit/agents-plugin-silero": patch
---

Bump `onnxruntime-node` (and `onnxruntime-common`) to `1.24.3` to fix a libc++abi mutex abort during process shutdown on macOS arm64. The crash fired in `~unique_ptr<OrtEnv>` inside `libonnxruntime.1.21.0.dylib` when `silero.VAD.load()` had been called and the process exited while LiveKit's tokio runtime threads were still alive — a static-destructor race present in `onnxruntime-node@1.21.0..1.23.2` and fixed upstream in `onnxruntime-node@1.24.1`. Verified the bump resolves the crash for the minimal repro in #1375.
