---
'@livekit/agents': patch
---

Port AMD result → `AMDPredictionEvent` rename and event emission from Python (livekit/agents#5621). The `AMD` detector now extends an `EventEmitter` and emits `amd_prediction` with an `AMDPredictionEvent` payload (`type: 'amd_prediction'`, plus the existing `category` / `reason` / `transcript` / `rawResponse` / `isMachine` fields and a new optional `speechDurationMs`). `AMDResult` is kept as a deprecated type alias for `AMDPredictionEvent` for backward compatibility. The remote-session wire serialization for AMD predictions is intentionally deferred until `@livekit/protocol` ships the corresponding `AgentSessionEvent.AmdPrediction` / `AmdCategory` message types; a TODO marker has been left in `voice/remote_session.ts` where it will be wired up.
