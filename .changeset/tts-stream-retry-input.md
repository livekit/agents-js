---
'@livekit/agents': patch
---

Fix streaming TTS retries by replaying buffered input into isolated provider attempts, rebuilding one-shot provider state, and avoiding retries after audio has already been emitted.
