---
'@livekit/agents': patch
---

Fail fast with a clear error when a DuplexModel such as GPT-Live is started under a text simulation, which has no audio, instead of timing out on the first reply.
