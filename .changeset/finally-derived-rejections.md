---
'@livekit/agents': patch
---

Handle the promise returned by `.finally(...)` on background tasks. A failing speech task, participant entrypoint, TTS request or worker task no longer surfaces as an unhandled promise rejection; the pipeline-reply cleanup now runs as a `Task` done callback (after the speech handle is marked done, as in Python), and a throwing `SpeechHandle` or `Task` done callback is logged instead of skipping the remaining callbacks or crashing the process.
