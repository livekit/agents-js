---
'@livekit/agents': patch
---

Replace the abandoned `@ffmpeg-installer/ffmpeg` (FFmpeg 4.1.x from 2019) with LiveKit-built, LGPL-2.1 FFmpeg 7.x binaries. The binaries are minimal (~3 MB, `--disable-network`, no GPL components) and restricted to an explicit allowlist of royalty-free audio codecs — PCM, MP3, FLAC, Vorbis, Opus, ALAC