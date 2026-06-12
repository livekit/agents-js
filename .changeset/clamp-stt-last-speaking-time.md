---
'@livekit/agents': patch
---

Clamp the STT-derived `lastSpeakingTime` to the current wall-clock time. When the STT stream's clock diverged from the activity's input epoch (e.g. a reused STT pipeline after an agent handoff), the transcript `endTime` could map to a timestamp minutes in the future, causing the end-of-turn bounce task to sleep that long before committing the user turn — the agent appeared to go silent mid-call even though LLM preemptive generation kept running.
