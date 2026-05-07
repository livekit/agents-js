---
"@livekit/agents-plugin-fishaudio": patch
---

Add Fish Audio TTS plugin (`@livekit/agents-plugin-fishaudio`). Streams via the
Fish Audio Live TTS WebSocket endpoint for low-latency synthesis (sentence-level
flushing, ~230ms TTFB), with HTTP `/v1/tts` for one-shot synthesis. Output is
raw 16-bit PCM (24 kHz default).
