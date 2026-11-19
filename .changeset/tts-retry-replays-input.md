---
'@livekit/agents': patch
---

Fix retried `inference.TTS` streams sending no text, which left the retried turn silent with no error. A streaming TTS can now replay everything pushed so far into each retry attempt, and stop retrying once audio has been emitted, reporting the error as unrecoverable instead. This is opt-in through the protected `SynthesizeStream.replayInputOnRetry` field, which is off by default; `inference.TTS` turns it on. Plugins are unchanged until each opts in.
