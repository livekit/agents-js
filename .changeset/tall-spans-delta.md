---
'@livekit/agents': patch
---

Record LLM trace inputs as deltas of the previous committed generation when `record.inputDelta` is enabled. `gen_ai.system_instructions` now holds only the agent's instructions message; other system messages stay in `gen_ai.input.messages`.
