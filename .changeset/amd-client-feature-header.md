---
'@livekit/agents': patch
---

Tag AMD's own LiveKit Inference requests with `X-LiveKit-Client-Feature: AMD`, add `extraHeaders` to `inference.STT.stream()`, and send the SDK metadata headers on Inference STT connections.
