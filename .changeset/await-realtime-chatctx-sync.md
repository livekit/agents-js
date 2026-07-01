---
'@livekit/agents': patch
---

Await active realtime chat context updates through `Agent.updateChatCtx()` so callers can reliably sequence follow-up model turns after conversation item sync completes.
