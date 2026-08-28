---
'@livekit/agents': patch
---

Re-attach the human agent room close listener when a warm transfer merge fails. A human agent who hangs up after the failed move now completes the task instead of leaving the caller on hold.
