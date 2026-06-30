---
'@livekit/agents': patch
---

Add `AudioStreamDecoder`, a streaming audio decoder that turns a pushed byte stream (e.g. a TTS or network audio segment) into decoded PCM `AudioFrame`s without writing to disk first. 16-bit PCM WAV is decoded in pure JS with no subprocess; other formats (mp3, flac, vorbis, opus/ogg, alac) are decoded through the bundled LGPL ffmpeg binary. Supports per-segment sample-rate and channel conversion and accepts either an ffmpeg `format` hint or an `audio/*` `mimeType`.
