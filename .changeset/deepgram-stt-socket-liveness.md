---
'@livekit/agents-plugin-deepgram': patch
---

Detect a silently dropped STT socket instead of hanging. Adds a ping/pong heartbeat to both STT streams, makes the v1 stream observe its connection monitor (`wsMonitor.result`, not `wsMonitor`, which left its retry path unreachable), lets the v2 stream reconnect from a mid-session close, and cancels an attempt's audio read on teardown so a torn-down sender cannot steal frames from the next one.
