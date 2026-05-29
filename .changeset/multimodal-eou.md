---
"@livekit/agents": minor
"@livekit/agents-plugin-silero": minor
"@livekit/agents-plugins-livekit": minor
---

feat(core): multimodal end-of-turn detection with cloud → local fallback (AGT-2520)

- New `inference.AudioTurnDetector`: WebSocket cloud EOT transport (`eot-audio`) with automatic fallback to the local native model (`eot-audio-mini`) via `@livekit/local-inference`. Auto-selects cloud when `LIVEKIT_REMOTE_EOT_URL` is set, local otherwise.
- The local EOT model runs in the shared inference process (the same `InferenceProcExecutor` the text turn detector uses), loaded once per worker host (~138 MB) instead of in every job worker. The runner is registered by default when the native binding is available, so the inference process spawns on worker startup; on platforms where the binding can't load, local EOT degrades to a positive-default prediction and the worker still starts. (This is a JS-specific divergence from Python, which keeps EOT in-process and relies on forkserver COW sharing.)
- No prewarm helpers: EOT auto-warms in the inference process; the in-process silero VAD lazy-loads on first stream. (The `inference.prewarm*` helpers added during development were removed before release.)
- New `inference.VAD` (local-only streaming VAD via `@livekit/local-inference`).
- `AgentSession` now auto-provisions a bundled silero VAD when `vad` is omitted (`isDefault=true`). Pass `vad: null` to opt out.
- `livekit-plugins-silero` is deprecated; pass `vad: null` to opt out of the bundled default, or use `inference.VAD({ model: 'silero', ... })` to customise.
- `livekit-plugins-livekit` turn detector is deprecated in favor of `inference.AudioTurnDetector`.
- New `EOTInferenceMetrics` and `EOTModelUsage`; new telemetry span attributes (`lk.eou.source`, `lk.eou.from_cache`, `lk.eou.detection_delay`); new `eot_prediction` event forwarded over remote sessions.
- Requires `@livekit/protocol` >= 1.46.2 (exposes the `AgentInference` message namespace used by the cloud transport).
