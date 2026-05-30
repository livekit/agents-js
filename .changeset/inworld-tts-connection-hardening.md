---
'@livekit/agents-plugin-inworld': minor
---

Harden the Inworld TTS connection layer (retryable framework errors, a handshake timeout and a bounded in-turn wait, and no in-plugin backoff so retries are delegated to the framework) and change the defaults to the `inworld-tts-2` model and `Jason` voice.
