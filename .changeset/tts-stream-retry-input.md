---
'@livekit/agents': patch
---

Fix streaming TTS retries by replaying buffered input into each new attempt and avoiding retries after audio has already been emitted.
