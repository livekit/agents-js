---
'@livekit/agents-plugin-elevenlabs': patch
---

fix(elevenlabs): surface error messages from the realtime STT server. An `auth_error`, `quota_exceeded`, `input_error`, `transcriber_error` or `error` message now ends the attempt with an error event instead of only being logged, and the first three are not retried.
