---
'@livekit/agents': patch
---

Trace the end-of-turn wait (`eou_wait`), the `onUserTurnCompleted` hook, and the speech queue wait, with per-turn stage attributes on the reply's `agent_turn`. Every duration attribute on a span is now in seconds like the Python SDK: `lk.eou.endpointing_delay`, `lk.eou.detection_delay`, `lk.transcription_delay`, `lk.end_of_turn_delay`, `lk.amd.speech_duration` and `lk.amd.delay` were reported in milliseconds before.
