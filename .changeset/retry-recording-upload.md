---
'@livekit/agents': patch
---

Retry session recording uploads when LiveKit Cloud responds with a
`google.rpc.RetryInfo` detail. The observability upload now rebuilds the
multipart form for up to 3 retries, parsing the server-provided retry delay
from the protobuf `Status` body and sleeping for that duration before
reattempting. Non-retryable errors (no `RetryInfo` detail) fail immediately
as before. Ports livekit/agents#5627.
