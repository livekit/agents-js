---
'@livekit/agents': patch
---

Stop sending `FunctionCall.extra` on the agent session wire format; it is removed in livekit/protocol#1978.
