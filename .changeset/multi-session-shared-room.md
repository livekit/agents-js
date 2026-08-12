---
'@livekit/agents': patch
---

Fix multiple `AgentSession.start({ room })` calls in one job failing with `A byte stream handler for topic "lk.agent.session" has already been set.` — only the primary session now creates the `SessionHost`/`RoomSessionTransport`, mirroring the Python `is_primary` gate, so per-participant sessions (e.g. multi-user transcription) can share a room.
