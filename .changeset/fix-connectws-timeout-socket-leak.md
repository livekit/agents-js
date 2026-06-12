---
'@livekit/agents': patch
---

Fix orphaned WebSocket leak in `connectWs`: when the connection timeout fires, the socket is now terminated so it cannot connect and linger without an owner. Also fixes a hang where a normal (code 1000) close during the handshake left the promise unsettled — it now rejects on any close before the socket opens. Uses `APITimeoutError` instead of `APIConnectionError` for clearer retry semantics.
