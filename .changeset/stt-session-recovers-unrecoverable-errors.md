---
'@livekit/agents': patch
---

Recover the STT stream after an unrecoverable error instead of closing the session on the first one: `AgentSession` now applies `maxUnrecoverableErrors` to `stt_error` (reset by a user transcript) like it does for LLM and TTS, and the STT pipeline recreates its stream after a connection failure. Matches livekit/agents#6418.
