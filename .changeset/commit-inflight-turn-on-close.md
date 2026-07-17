---
'@livekit/agents': patch
---

Commit the in-flight assistant turn (interrupted: true, partially-forwarded text) when the session closes mid-playout — previously a room disconnect during playback dropped the turn from chatCtx entirely, with no ConversationItemAdded emitted (#2041)
