---
'@livekit/agents': patch
---

fix(voice): stop dropping agent turns whose playback starts after audio forwarding completes (#1909, #1960; port of livekit/agents#5039).

`forwardAudio` used to reject `firstFrameFut` (and detach its `PLAYBACK_STARTED` listener) in its `finally` block whenever no frame had played by the time forwarding finished. Two real scenarios hit this window: a speech paused in the thinking state by a brief user sound, whose buffered first frame only plays after the false interruption clears (#1909), and DataStream avatar outputs with `waitPlaybackStart: true`, which deliver `lk.playback_started` ~1s after frames were captured (#1960). In both cases the late playback-started event found nothing listening, the reply was classified "skipped", and the turn was silently removed from the chat context while the agent never entered the `speaking` state.

The `PLAYBACK_STARTED` listener now lives in `performAudioForwarding` so it outlives the forwarding task, and `forwardAudio` no longer settles the future; the reply tasks (including the `say()` path) settle it once the playout window ends, which also detaches the listener. A reported non-zero playback position on interruption is additionally honored as evidence of partial playback — but only when the segment actually captured a frame into the output (tracked via the output's segment count, which is also what makes the reported position fresh rather than stale) — covering avatars whose playback-started RPC races the interruption itself.
