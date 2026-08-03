---
'@livekit/agents': patch
---

Avoid dropping realtime turns or resuming agent speech before a paused turn decision settles.

A turn decision that is cancelled no longer resumes the paused speech, and one that fails no
longer leaves the agent's audio output paused indefinitely.
