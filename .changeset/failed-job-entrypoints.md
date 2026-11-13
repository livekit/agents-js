---
'@livekit/agents': patch
---

Report jobs whose entrypoints throw before shutdown as failed after their normal cleanup completes, and disconnect them with the AGENT_ERROR reason.

Also report failures during job setup before the entrypoint starts, and clean up per-job telemetry before exiting.

Require @livekit/rtc-node 1.2.2 or later for disconnect reason support.
