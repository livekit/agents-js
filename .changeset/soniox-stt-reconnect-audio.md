---
'@livekit/agents-plugin-soniox': patch
---

Fix Soniox STT after a retried connection: the failed attempt's audio sender no longer keeps reading input, so the new connection gets every frame instead of every other one.
