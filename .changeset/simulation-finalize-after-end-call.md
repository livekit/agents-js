---
'@livekit/agents': patch
---

Keep the session host up for the whole job, so a simulation's `onSimulationEnd` verdict is no longer dropped when the agent ends the call before the simulator finalizes.
