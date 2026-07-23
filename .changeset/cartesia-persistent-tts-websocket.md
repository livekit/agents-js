---
'@livekit/agents-plugin-cartesia': patch
---

Reuse a single Cartesia TTS WebSocket across generations instead of opening and closing one per synthesis. The plugin now holds a `ConnectionPool` on the `TTS` instance (matching the Python plugin and the fishaudio/inworld/xai plugins), so only the first turn pays the connect and later turns skip the TCP/TLS and WebSocket handshake. Adds `TTS.prewarm()` to open the socket before the first turn and a `TTS.close()` that drains the pool.
