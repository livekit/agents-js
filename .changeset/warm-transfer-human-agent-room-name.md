---
'@livekit/agents': patch
---

Add an optional `roomName` option to `WarmTransferTask`, allowing the human-agent briefing room to be pre-created with custom configuration (e.g. an egress request to record the transfer leg) before the task dials the human agent.
