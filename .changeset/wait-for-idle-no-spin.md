---
'@livekit/agents': patch
---

Stop `waitForIdle` from spinning on `delay(0)` while the agent or the user is speaking. It now waits for the current speech to end or for the user state to change, which also cuts the calls that leave abort listeners on the activity's close signal.
