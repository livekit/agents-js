---
"@livekit/agents": patch
---

A job process whose worker is gone now exits at once, without leaving the room, so the server dispatches the job again. Before, it shut down gracefully after 15s, and the server took the job as done.
