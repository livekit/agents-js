---
'@livekit/agents': patch
---

Keep an error listener on every adaptive interruption WebSocket so a failed, abandoned or replaced socket no longer throws an uncaught `WebSocket was closed before the connection was established` error, and stop opening a gateway session when the transport closes during the handshake.
