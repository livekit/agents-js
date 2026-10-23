---
'@livekit/agents-plugin-soniox': patch
---

Send Soniox's finalize message when the STT stream is flushed, so the final transcript no longer waits for Soniox's own endpoint detection.
