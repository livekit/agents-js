---
'@livekit/agents': patch
---

Stop a late VAD or STT end-of-speech event from setting a turn's `startedSpeakingAt`. A turn now
reports the onset of its first start-of-speech event, or none when no start was observed.
