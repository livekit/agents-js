---
'@livekit/agents': patch
'@livekit/agents-plugin-cartesia': patch
'@livekit/agents-plugin-deepgram': patch
'@livekit/agents-plugin-meta': patch
---

Stop the STT send loops from retaining every audio frame for the life of a stream, and from stealing the next attempt's first frame. `inference.STT` and the Cartesia, Deepgram and Meta STTs raced each read against one long-lived abort promise; every race appended a reaction to that never-settling promise, and each reaction kept the settled read and its `AudioFrame` alive (nodejs/node#17469) — about 8 MB per minute per stream under continuous speech, until the job hit its memory limit. Reads now go through the input queue's cancellable `next({ signal })`, so a torn-down sender's read is cancelled instead of left parked in the queue, and any remaining race goes through `waitUntilAborted`, which installs and removes its own abort listener per call.
