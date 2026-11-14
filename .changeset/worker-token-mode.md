---
'@livekit/agents': patch
---

Add token mode, for an agent that holds no API key or secret: give the worker a pre-minted worker token in `LIVEKIT_TOKEN` (or the `token` option, or `--token`) and set no API key or secret. The worker registers with that token and uses it for its own inference and telemetry calls. A job gets the token for each server API call from the server, through its worker, with the new `CreateJobToken` worker message. With an API key and secret set, nothing changes.
