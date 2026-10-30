---
"@livekit/agents": patch
---

Report worker status every 1.5s and keep reporting it while draining. The default load is now a moving average of CPU samples over 2.5s, as in the Python SDK.
