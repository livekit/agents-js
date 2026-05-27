---
'@livekit/agents': patch
---

internal(voice): wire `DebugMessage` over the remote-session wire

Bumps `@livekit/protocol` to `^1.46.4` and wires the new
`AgentSessionEvent.debug_message` (livekit/protocol#1593) through
`SessionHost` / `RemoteSession`.

Internal-only — the framework exposes an unstable `AgentSession._emitDebugMessage(payload)`
for the debugger/recorder; not intended for user code.

Also unlocks `AgentSessionEvent.FunctionToolsStarted`,
`AgentSessionEvent.EotPrediction`, and `SessionRequest.UpdateIO` for
downstream consumers.
