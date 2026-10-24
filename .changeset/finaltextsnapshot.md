---
"@livekit/agents": patch
---

Fix non delta transcription final streams publishing wrong or empty text: snapshot the segment text when the flush is scheduled instead of reading shared mutable state inside the async flush task.
