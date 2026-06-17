---
"@livekit/agents": patch
---

feat(eot): emit agent backchannel opportunity events (AGT-2520)

The multimodal EOT model now returns a backchannel probability alongside the end-of-turn probability. The turn detector compares it to a server-provided threshold and, when it clears, surfaces an internal backchannel *opportunity* (a window where the agent could say a short "mm-hmm" while the user still holds the floor) to `AgentActivity`.

- `inference.TurnDetector` gains a `backchannelThreshold` option (and `updateOptions({ backchannelThreshold })`); `ThresholdOptions.lookupBackchannel()` resolves server-provided defaults layered with user overrides, mirroring the existing EOT threshold resolution.
- Backchannel thresholds are server-driven and cloud-only — disabled when the gateway sends none, after a cloud→local fallback (the mini model produces no backchannel probability), and for any non-positive threshold.
- Internal only: `AgentActivity.onAgentBackchannelOpportunity` is a no-op with a TODO; the event is not surfaced as a public `AgentSession` event (absent from the `AgentEvent` union, `AgentSessionEventTypes`, and package exports), treated the same way as the internal EOT prediction plumbing.
- Requires `@livekit/protocol` >= 1.46.8 (adds `EotPrediction.backchannelProbability` and `SessionCreated.defaultBackchannelThresholds` / `defaultBackchannelThreshold`).
