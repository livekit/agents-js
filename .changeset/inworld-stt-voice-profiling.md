---
"@livekit/agents-plugin-inworld": patch
---

feat(inworld): add STT plugin with voice profiling support

Adds `STT` and `SpeechStream` to the Inworld plugin, porting the Python `livekit-plugins-inworld` STT implementation to TypeScript. Supports both streaming (bidirectional WebSocket) and batch (REST) modes, word-level timestamps, and acoustic voice profiling (emotion, accent, age, pitch, vocal style) via `SpeechData.metadata.voiceProfile`.
