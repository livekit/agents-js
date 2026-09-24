---
'@livekit/agents': patch
---

Handle the promises returned by `.finally(...)` on background tasks, so a failed speech task, participant entrypoint, TTS request or worker task no longer produces an unhandled promise rejection. Speech replies register their cleanup with `Task.addDoneCallback`, a throwing `SpeechHandle` done callback no longer skips the remaining callbacks, and failures of participant entrypoints and worker tasks are logged instead of surfacing as unhandled rejections.
