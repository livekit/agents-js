---
'@livekit/agents': patch
---

Keep the session host open for `finalize_simulation` after the agent ends the call, so a simulation's `onSimulationEnd` verdict is no longer dropped when the agent hangs up first.
