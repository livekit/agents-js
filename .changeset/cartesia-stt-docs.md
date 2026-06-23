---
'@livekit/agents-plugin-cartesia': patch
---

Preserve Cartesia STT partial transcripts when final turn events omit transcript text. Add a `language` option that routes non-English languages to the multilingual `ink-whisper` model (English stays on `ink-2`) and normalizes language codes on the emitted transcripts.
