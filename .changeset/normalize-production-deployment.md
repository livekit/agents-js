---
'@livekit/agents': patch
---

Treat `LIVEKIT_AGENT_DEPLOYMENT=production` as the default deployment, so the worker joins the production dispatch pool instead of a separate one.
