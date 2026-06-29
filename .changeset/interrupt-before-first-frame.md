---
'@livekit/agents': patch
---

Fix agent speech being silently dropped when interrupted before its first audio frame plays (#1909, port of livekit/agents#5039).

When the agent is in the "thinking" state and the user makes a brief sound before the first TTS frame is forwarded, `onStartOfSpeech` pauses the not-yet-playing speech (this thinking-state pause is intentional and preserved). The frames were still captured into the paused output buffer, but `forwardAudio`'s `finally` block rejected `firstFrameFut` (and removed its `PLAYBACK_STARTED` listener) whenever no frame had played yet. So when a false interruption cleared and the output resumed, the buffered first frame played but nothing was listening — the future stayed rejected, and because the reply tasks gate transcript preservation on `firstFrameFut.done && !firstFrameFut.rejected`, the resumed turn was dropped from history even though audio reached the user.

The `PLAYBACK_STARTED` listener now lives in `performAudioForwarding` so it outlives the forwarding task, and `forwardAudio` no longer rejects the future; a late first frame (e.g. after a `resumeFalseInterruption` resume) can still resolve it. The reply tasks settle the future after playout finishes or is interrupted to remove the listener. A genuine interruption after a resume now keeps its partial synchronized transcript instead of losing the turn.
