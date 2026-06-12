---
'@livekit/agents': patch
---

Fix orphaned WebSocket leak in `connectWs`: when the connection timeout fires, the socket is now terminated so it cannot connect and linger without an owner. Also uses `APITimeoutError` instead of `APIConnectionError` for clearer retry semantics.
