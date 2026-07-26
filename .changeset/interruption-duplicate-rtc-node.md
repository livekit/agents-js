---
'@livekit/agents': patch
---

fix(interruption): stop silently dropping all audio when `@livekit/rtc-node` is loaded twice

When an application and `@livekit/agents` resolve two different installs of `@livekit/rtc-node` —
easily done by linking a local checkout, or by a transitive version split — room audio is built by
one `AudioFrame` constructor and type-checked against the other. Every `frame instanceof AudioFrame`
went false, so audio was pushed into the interruption stream as if it were a control sentinel,
matched none of the sentinel branches in the transform, and disappeared: no accept, no drop, no
counter, no log. Adaptive interruption had nothing left to classify and answered **every** overlap
with the default backchannel verdict, so the agent never yielded to the user — with no error, no
warning and no failover to give the cause away.

- Audio is now recognised by shape rather than by constructor identity. A frame from another copy
  of the module is rebuilt as a local `AudioFrame` (over the same sample buffer, so no copy) and
  keeps flowing, which also stops a foreign frame being handed to a resampler backed by a different
  FFI runtime.
- The first such frame raises a once-per-process `error` naming the duplicate dependency and how to
  find and collapse it, instead of leaving the failure to be inferred from a classifier that only
  ever says "backchannel".
- The transform's sentinel dispatch is now an exhaustive `switch`, and anything it cannot classify
  is reported at `error` (rate limited, with a running count of discarded chunks) rather than
  falling off the end of the chain.

Two other cross-package `instanceof` checks that would fail the same way are now structural:
`RoomIO`'s participant audio input no longer mistakes a `RemoteParticipant` for an identity string
and subscribes to nothing, and `waitForParticipantAttribute` no longer waits forever.
