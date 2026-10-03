---
'@livekit/agents': patch
---

Deprecate unused `BaseStreamingTurnDetector` members — `thresholds`, `backchannelThreshold`, and `supportsLanguage` on the detector, and `provider` on `BaseStreamingTurnDetectorStream` — in favor of the parallel APIs on the stream returned by `stream()` and `provider` on the owning detector. They remain available and will be removed in a future major version.
