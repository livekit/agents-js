---
'@livekit/agents-plugin-rime': patch
'@livekit/agents': patch
---

Add Rime WebSocket v1 streaming with binary and JSON support through the published
protocol package. Support sentence input, cancellation, connection reuse, and all
six audio formats. Keep HTTP and WS3 support, use consistent sample rates, and
remove provider and transport details from errors.

Handle terminal HTTP TTS errors through the existing error event without leaving
an unhandled background rejection.
Keep Rime stream metrics tied to their fixed options and let inference stream
metrics follow model updates. Handle tokenizer failures while input remains open.
Retry Rime v1 requests that complete without audio for nonempty input.
