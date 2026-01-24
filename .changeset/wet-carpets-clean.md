---
'@livekit/agents-plugins-test': patch
'@livekit/agents': patch
---

fix: handle VAD stream closed error during agent handover

- Fixed a race condition in `StreamAdapter` where `endInput()` could be called on an already-closed VAD stream during agent handover, causing an unrecoverable `stt_error`. This affected non-streaming STTs (like OpenAI STT) that use the StreamAdapter wrapper.
- Added `isStreamClosedError()` utility function for consistent error handling.
- Upgraded sharp from 0.34.3 to 0.34.5 to fix libvips version conflict (1.2.0 vs 1.2.4) that caused flaky agent behavior and ObjC class collision warnings on macOS.
- Fixed pre-existing build error in test plugin (Int16Array to ArrayBuffer conversion).
