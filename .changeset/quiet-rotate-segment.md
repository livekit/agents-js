---
'@livekit/agents': patch
---

fix(transcription): quiet the `rotateSegment` overlap warning. The single-overlap case (one rotation queued behind another) is expected at normal turn boundaries — rotations are safely serialized via `oldTask.result`. Track the queue depth instead and only warn when more than one rotation is stacked behind the in-flight one, and additionally suppress the warn during the synchronizer's startup window: production data shows the room-connection-state-changed event can stack two extra rotations onto the constructor-scheduled initial task, producing a benign depth=2 chain that drains before any audio is produced. After the initial task resolves, real mid-conversation backlogs still trip the warn.
