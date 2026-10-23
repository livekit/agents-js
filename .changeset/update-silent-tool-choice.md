---
'@livekit/agents': patch
---

Add `silent` to `ctx.update()`. A silent update is recorded for the model with no reply. The reply to an update still uses `toolChoice: 'none'`, and the reply to an async tool's final result now uses the model's default tool choice instead of `'none'`.
