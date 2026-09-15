---
'@livekit/agents': patch
---

Trace RPC calls the agent performs (`rpc_call`) and handles (`rpc_handler`) through the room SDK's `RpcInterceptor` hook. `@livekit/rtc-node` `^1.1.0` is now required, the first release with `LocalParticipant.addRpcInterceptor`.
