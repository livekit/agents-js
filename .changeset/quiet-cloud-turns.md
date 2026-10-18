---
'@livekit/agents': patch
---

Add `inference.TurnDetector({ localFallback: false })` to disable cloud-to-local fallback, matching Python. Prediction timeouts keep cloud detection active. A terminal cloud failure disables detection for the stream and lets endpointing commit turns. Fallback remains enabled by default.
