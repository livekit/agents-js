---
'@livekit/agents': patch
---

Send the instructions passed to `generateReply`, including the guidance for an async tool's deferred reply, as their own system message on the LLM path, as the Python SDK does. The agent's instructions now stay unchanged in that request.
