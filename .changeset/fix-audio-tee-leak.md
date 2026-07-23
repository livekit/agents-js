---
"@livekit/agents": patch
---

fix: drain unused audio tee branches to prevent unbounded RSS growth when no VAD/STT consumer is configured
