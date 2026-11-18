---
'@livekit/agents-plugin-rime': patch
---

Add Rime Prism speech-to-speech through `AgentSession`, with tools, asynchronous tool
progress, shared history, standard strict context edits, settings updates, and provider
cancellation. Update the Rime SDK to 0.1.0-alpha.28. Preserve server-retained text after
interruptions and expose each SDK event through `rime_server_event_received`. Add
estimated or discarded playback, initial connection retries, and realtime metrics.
Add recording and VAD streaming speech recognition, Coda custom lexicons, and the current
model-specific default voices. The Rime plugin now requires Node.js 22 or later. Existing
TTS APIs and ESM/CommonJS imports remain supported.
