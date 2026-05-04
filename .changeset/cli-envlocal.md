---
"@livekit/agents": minor
---

Auto-load `.env.local` from the current working directory when running the
agent CLI in `dev` or `connect` mode. Existing `process.env` values take
precedence, so shell exports always win.
