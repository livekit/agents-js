---
"@livekit/agents": patch
---

Guard WritableStream close in RoomIO teardown to prevent ERR_INVALID_STATE when writer is already closed or errored during concurrent speech interruption
