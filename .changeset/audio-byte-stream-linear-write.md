---
'@livekit/agents': patch
---

`AudioByteStream.write` appends the new bytes with `Int8Array.set` instead of rebuilding its buffer through an array spread, which boxed every byte into a temporary array on each write.
