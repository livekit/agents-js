---
'@livekit/agents-plugin-assemblyai': patch
---

Stop a finished AssemblyAI STT connection from taking audio frames meant for the next one. The send
loop now cancels its queue read when the connection ends instead of leaving it parked, so no audio
is lost after a reconnect.
