---
'@livekit/agents': patch
---

Fix the agent transcript running one reply behind. When a reply's playback finished before its text stream closed, the late text flush marked the next segment as ended. The next reply then queued that empty segment as if its playback finish were still pending. From then on, each playback finish settled the previous reply's segment, and interrupted replies were committed to the chat context with the previous reply's text. The synchronizer now queues a rotated segment only when it carried audio and its playback finish has not arrived.
