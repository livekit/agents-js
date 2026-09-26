---
'@livekit/agents-plugin-xai': patch
---

Reconnect the xAI STT stream when its socket drops mid-session. The stream now observes its connection monitor (`wsMonitor.result`, not `wsMonitor`) and settles each attempt's audio sender before reconnecting, so a leftover sender cannot steal frames from the new socket.
