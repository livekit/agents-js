---
'@livekit/agents': patch
---

fix(voice): commit interrupted replies when playback start is reported after audio forwarding completes (avatar outputs). `forwardAudio` no longer rejects `firstFrameFut` when forwarding finishes before the remote avatar's deferred `lk.playback_started` notification arrives — previously the interrupted reply was classified "skipped" and silently dropped from the chat context, and the agent never entered the `speaking` state. A reported non-zero playback position on interruption is now also honored as evidence of partial playback.
