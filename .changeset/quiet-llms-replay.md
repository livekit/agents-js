---
'@livekit/agents': patch
---

Replay LLM responses from a recorded session when `LIVEKIT_LLM_REPLAY_URL` is set (used by `lk agent simulate replay`): every provider request is served the recorded output instead of calling the provider, and the session runs text-only.
