---
'@livekit/agents': patch
---

LiveKit Inference STT: an interim transcript with no text no longer keeps a finalizing stream open. `xai/stt-1` sends one every second after `session.finalized` for as long as the socket is open, so a stream on it never ended after `endInput()`; it now closes 3 s after the last final like every other model.
