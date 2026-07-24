---
'@livekit/agents': patch
---

Fix updateAgent handoffs so run() captures onEnter output without waiting indefinitely on long-lived onEnter flows.
