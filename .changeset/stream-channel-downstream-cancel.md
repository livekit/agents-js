---
'@livekit/agents': patch
---

Stream channels: tolerate the consumer cancelling the readable side. Fire-and-forget write() and close() on a downstream-cancelled channel no longer surface as unhandled promise rejections (`Error: undefined`), the `closed` getter now reflects downstream cancellation, and the audio forwarder cancels its reader with a real reason.
