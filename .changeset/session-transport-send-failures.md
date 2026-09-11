---
'@livekit/agents': patch
---

Session transports now throw when a message cannot be sent because the transport is closed or the room is disconnected, instead of returning silently. A RemoteSession request over a dead transport fails at once rather than waiting out its timeout, and the session host logs a failed event send with one warning. Matches the Python SessionTransport contract.
