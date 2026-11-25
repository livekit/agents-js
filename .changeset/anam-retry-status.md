---
'@livekit/agents-plugin-anam': patch
---

Anam session start now retries only failures that can succeed on retry (network errors, 5xx, 408, 429 and 499) and fails at once on other 4xx responses, matching the Python plugin. It makes `maxRetry + 1` attempts, throws `APIStatusError` or `APIConnectionError` instead of `AnamException`, rejects a malformed `ANAM_API_URL` without retrying, and no longer logs the LiveKit join token.
