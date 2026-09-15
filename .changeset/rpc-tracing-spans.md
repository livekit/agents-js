---
'@livekit/agents': minor
---

Trace RPC calls the agent performs (`rpc_call`) and handles (`rpc_handler`) through the room SDK's `RpcInterceptor` hook; a no-op on an `@livekit/rtc-node` without `addRpcInterceptor`.
