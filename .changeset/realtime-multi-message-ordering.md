---
'@livekit/agents': patch
---

fix(realtime): process all messages in multi-message realtime generations

Reorders audio/text forwarding setup inside `processOneMessage` to match the
Python source order (audio first, then text), and tightens the playout-await
guard so `playoutPromise` is only awaited when not interrupted. This fixes a
case where the second message in a multi-message realtime response (e.g.
`gpt-realtime-2` preambles) could be dropped.

Also stamps assistant `ChatMessage.createdAt` with `startedSpeakingAt` (the
first frame's playback start) instead of defaulting to `Date.now()` at
end-of-generation. This preserves correct user/assistant ordering in
`ChatContext` when user transcription items land during agent playout.
