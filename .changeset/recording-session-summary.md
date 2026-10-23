---
'@livekit/agents': patch
---

Send a session summary and the session duration in the recording upload header. The summary is the session report JSON without chat history, events and the local recording path. `sessionReportToJSON` now also emits `agent_name`, `duration_ms`, `user_turns`, `errors` and `close_reason` (a `livekit.agent.CloseReason` name), with `null` for unknown values, and takes options to omit the chat history and events. `SessionReport` gains `agentName`.
