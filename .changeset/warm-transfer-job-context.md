---
'@livekit/agents': patch
---

fix(warm-transfer): capture job context for post-merge caller-room cleanup

`WarmTransferTask`'s post-merge `RoomEvent.ParticipantDisconnected` listener called `getJobContext()` to build a `RoomServiceClient` and delete the caller room. That handler runs from a native rtc-node FFI callback whose `AsyncLocalStorage` context is pinned to `FfiClient`-singleton creation, not to the job's context — so `getJobContext()` read an empty (or stale) store and threw, surfacing as an unhandled promise rejection and leaving the 2-party SIP room undeleted when a participant hung up after the bridge. The task now captures the `JobContext` eagerly in `onEnter()` (while the live context is available) and uses `jobCtx.deleteRoom()` in the late handler, which also passes the job's API credentials instead of relying on environment variables.
