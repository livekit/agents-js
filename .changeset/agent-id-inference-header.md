---
'@livekit/agents': patch
---

Add the agent participant SID as an `X-LiveKit-Agent-Id` header on inference requests, alongside the existing room and job ID headers, when running inside a job context.
