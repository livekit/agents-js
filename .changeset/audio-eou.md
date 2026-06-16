---
"@livekit/agents": patch
"@livekit/agents-plugin-silero": patch
"@livekit/agents-plugins-livekit": patch
---

feat(core): audio end-of-turn detection with cloud → local fallback (AGT-2520)

- New `inference.TurnDetector`: WebSocket cloud EOT transport (`version: 'v1'`, model name `turn-detector-v1`) with automatic fallback to the local native model (`version: 'v1-mini'`, model name `turn-detector-v1-mini`) via `@livekit/local-inference`. Auto-selects `'v1'` when `LIVEKIT_REMOTE_EOT_URL` is set, `'v1-mini'` otherwise. The `version` is the constructor knob; telemetry/billing report the full model name via `detector.model`.
- The local EOT model runs in the shared inference process (the same `InferenceProcExecutor` the text turn detector uses), loaded once per worker host (~138 MB) instead of in every job worker. The runner is registered by default when the native binding is available, so the inference process spawns on worker startup; on platforms where the binding can't load, local EOT degrades to a positive-default prediction and the worker still starts. (This is a JS-specific divergence from Python, which keeps EOT in-process and relies on forkserver COW sharing.)
- No prewarm helpers: EOT auto-warms in the inference process; the in-process silero VAD lazy-loads on first stream. (The `inference.prewarm*` helpers added during development were removed before release.)
- New `inference.VAD` (local-only streaming VAD via `@livekit/local-inference`).
- `AgentSession` now auto-provisions a bundled silero VAD when `vad` is omitted (`isDefault=true`). Pass `vad: null` to opt out.
- `livekit-plugins-silero` is deprecated; pass `vad: null` to opt out of the bundled default, or use `inference.VAD({ model: 'silero', ... })` to customise.
- `livekit-plugins-livekit` turn detector is deprecated in favor of `inference.TurnDetector`.
- Endpointing defaults are now detector-aware: when the resolved turn detector is a streaming ("audio model") detector — the bundled default — unset endpointing keys fall back to tighter defaults (`minDelay: 300`, `maxDelay: 2500`) instead of the legacy `500`/`3000`. Non-streaming modes (`vad`/`stt`/`manual`/`realtime_llm`, or `turnDetection: null`) keep the legacy defaults. Explicit user keys are tracked as sparse overrides and re-resolved per agent activity, so different agents in one session can use different detectors and runtime `updateOptions` changes survive handoffs.
- New `EOTInferenceMetrics` and `EOTModelUsage`; new telemetry span attributes (`lk.eou.source`, `lk.eou.from_cache`, `lk.eou.detection_delay`); new `eot_prediction` event forwarded over remote sessions.
- Requires `@livekit/protocol` >= 1.46.5 (exposes the `AgentInference` message namespace used by the cloud transport, including the server-provided `SessionCreated` default thresholds).
