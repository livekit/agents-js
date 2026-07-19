---
'@livekit/agents-plugin-elevenlabs': patch
---

Pass the decoded audio chunk to `AudioByteStream` as a view rather than as its underlying `ArrayBuffer`. Node serves small `Buffer`s out of a shared pool, so the previous code discarded the chunk's `byteOffset` and `byteLength` and published the whole 8 KB pool as PCM, producing bursts of full-scale noise in the middle of synthesized speech.
