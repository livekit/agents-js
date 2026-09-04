---
'@livekit/agents': patch
---

Text-mode simulation jobs now send `X-LiveKit-Inference-Priority: low` on every inference request, overriding the model's configured `inferenceClass`, so simulation runs are paced into spare quota instead of competing with live voice traffic. Matches the Python SDK.
