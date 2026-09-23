---
'@livekit/agents': patch
---

Record the conversation on a realtime session's spans: `realtime_inference` now carries the system instructions, input messages, tool definitions and output messages, `agent_turn` carries the per-turn instructions and user input, and the model's own final transcript opens a `user_turn` span back-dated to the provider's turn start.
