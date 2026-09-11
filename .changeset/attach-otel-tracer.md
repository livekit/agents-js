---
'@livekit/agents': patch
---

feat(agents): add `metrics.attachOtelTracer(session, tracer)` helper

Subscribes to an `AgentSession`'s `metrics_collected` events and emits OpenTelemetry
spans following the `gen_ai.*` semantic conventions for LLM, STT, TTS, Realtime, EOU,
Interruption, and VAD metrics. Returns an unsubscribe function. Resolves #1407 (related
to #757).
