---
'@livekit/agents': patch
---

fix(agents): stop a terminally failed stream leaving an unhandled rejection

`LLMStream` and `STTStream` dropped the promise from their fire-and-forget main task, so a
stream that exhausted its retries rejected with no handler attached — reaching the job
process's `unhandledRejection` hook as a spurious crash report for a failure already
delivered through the `error` event, and failing any test run that exercises the path.

The task is now awaited inside a `try`/`finally` that closes the queue either way, matching
what `TTSStream` already does.
