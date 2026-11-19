---
'@livekit/agents-plugin-rime': patch
---

Add Rime Prism speech-to-speech through `AgentSession`. The Rime plugin now requires
Node.js 22 or later. Existing TTS APIs and ESM/CommonJS imports remain supported.

- Tools and asynchronous tool progress, with filler settings kept across handoffs.
- Shared history and standard strict context edits. A refused or known partial edit keeps
  accepted writes, including tool results and provider references; an uncertain partial
  edit closes the session.
- Settings updates, per-reply labels, and provider cancellation.
- Server-retained text after interruptions, including when queued playback is interrupted
  after the response completes. Each SDK event is exposed through
  `rime_server_event_received`.
- Estimated or discarded playback, initial connection retries, and realtime metrics.
- Recording and VAD streaming speech recognition, Coda custom lexicons, and the current
  model-specific default voices.
- The Rime SDK is updated to 0.1.0-alpha.28.
