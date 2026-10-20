---
'@livekit/agents': patch
---

Add `silent` and `toolChoice` to `ctx.update()`. A silent update is recorded for the model with no reply, and `toolChoice` (default `'none'`) sets what the reply to an update may call. The reply to an async tool's final result now uses the model's default tool choice instead of `'none'`.
