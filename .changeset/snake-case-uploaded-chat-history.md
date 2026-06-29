---
'@livekit/agents': patch
---

Serialize the uploaded session-recording `chat_history` in snake_case to match the Python wire schema. `uploadSessionReport` was stringifying `chatHistory.toJSON()` directly, which emits camelCase field names; the snake_case conversion lives only in `sessionReportToJSON` (`toSnakeCaseDeep`). As a result the uploaded chat history carried camelCase keys (`callId`, `args`, `isError`, `newAgentId`, `createdAt`), and the Python consumer's pydantic validation rejected the chat items with "field required" errors for `call_id`, `arguments`, `is_error`, and `new_agent_id`. The upload now reuses `sessionReportToJSON(report).chat_history` so the two serializations can't drift.
