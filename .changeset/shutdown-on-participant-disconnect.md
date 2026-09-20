---
'@livekit/agents': patch
---

`RoomIO` ends the job as soon as it has closed the primary `AgentSession` because the linked participant disconnected, instead of waiting for the server to close the empty room and disconnect the agent. Opt out with `RoomInputOptions.closeOnDisconnect=false`, which also keeps the session open, as in Python; `deleteRoomOnClose` deletes the room on close as before.
