---
'@livekit/agents': patch
---

fix(transcription): quiet the `rotateSegment` overlap warning. The single-overlap case (one rotation queued behind another) is expected at normal turn boundaries — rotations are safely serialized via `oldTask.result`. Track the queue depth instead and only warn when more than one rotation is stacked behind the in-flight one, which would indicate a genuine backlog.
