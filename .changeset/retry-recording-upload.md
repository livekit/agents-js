---
'@livekit/agents': patch
---

Retry session recording uploads up to 3 times after connection failures (DNS, refused or reset
connection, 30s connection timeout) and after responses that carry a `google.rpc.RetryInfo`
detail. Ports livekit/agents#5627 and livekit/agents#6977.
