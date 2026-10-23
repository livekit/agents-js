---
'@livekit/agents': patch
---

Send a session summary and the session duration in the recording upload header. The summary is the session report without chat history, events and the local recording path, plus the agent name, duration, user turns, error counts and the close reason as a `livekit.agent.CloseReason` name. `sessionReportToJSON` takes options to omit the chat history and events.
