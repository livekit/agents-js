---
'@livekit/agents': patch
---

fix realtime user turns appearing after the reply they prompted, by placing the user message at the time its turn began rather than at the time the provider delivered the transcript
