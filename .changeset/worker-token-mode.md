---
'@livekit/agents': patch
---

Add token mode, for an agent that holds no API key or secret: give the worker a pre-minted worker token in `LIVEKIT_TOKEN` (or the `token` option, or `--token`) and set no API key or secret. The worker registers with that token. A job gets its tokens from the server, through its worker, with the new `CreateJobToken` worker message: one for each server API call, and an inference and an observability token that it gets before the entrypoint runs and renews at half of their lifetime. In token mode, inference outside a running job throws. With an API key and secret set, nothing changes.
