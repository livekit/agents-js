---
'@livekit/agents': patch
---

Fix orphaned WebSocket leak in `connectWs` when the connection timeout fires before the socket opens. The socket is now terminated and all pending listeners removed on timeout. Also uses `APITimeoutError` instead of the generic `APIConnectionError` for clearer retry semantics.
