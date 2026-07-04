---
'@livekit/agents': patch
---

Trim the chat context recorded on the `eou_detection` span to the last 6 items and exclude function calls, instructions, empty messages, handoffs, and config updates (matching Python), so the span no longer re-emits the whole conversation on every end-of-turn inference.
