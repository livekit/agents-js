---
'@livekit/agents-plugin-xai': patch
---

Expose `endpointing` option on xAI STT to configure silence duration (in milliseconds) before an utterance-final event is fired. Defaults to 100ms (matching AssemblyAI's default) for better compatibility with LiveKit EOT models. Ported from livekit/agents#5493.
