---
'@livekit/agents': patch
'@livekit/agents-plugin-cartesia': patch
'@livekit/agents-plugin-meta': patch
---

Stop the STT send loops from retaining every audio frame for the life of a stream. `inference.STT`, the Cartesia STT and the Meta STT raced each `iterator.next()` against one long-lived abort promise; every race appended a reaction to that never-settling promise, and each reaction kept the settled `next()` promise and its `AudioFrame` alive (nodejs/node#17469) — about 8 MB per minute per stream under continuous speech, until the job hit its memory limit. Each item now races through `waitUntilAborted`, which installs and removes its own abort listener.
