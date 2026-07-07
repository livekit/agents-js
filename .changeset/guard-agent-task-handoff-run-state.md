---
'@livekit/agents': patch
---

Fix `session.run()` stalling or racing the activity transition when an AgentTask handoff is triggered by a speech that predates the run (e.g. created in `onEnter`): the blocked handoff tasks are now watched by the active run for the duration of the transition.
