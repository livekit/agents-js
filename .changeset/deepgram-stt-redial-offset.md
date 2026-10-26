---
'@livekit/agents-plugin-deepgram': patch
---

fix(deepgram): advance `startTimeOffset` by the audio the previous socket received whenever the Nova STT stream reopens its socket, so word times after a redial or an options reset no longer restart at zero
