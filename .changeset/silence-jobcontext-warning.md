---
"@livekit/agents": patch
---

fix: add `required` parameter to `getJobContext()`, matching Python SDK's `get_job_context(required=False)` pattern. Removes noisy warn-level log during evals/tests.
