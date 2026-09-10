---
'@livekit/agents': patch
---

Preserve trailing inference STT transcripts by finalizing input before requesting session closure, then wait for closure before ending the stream.
