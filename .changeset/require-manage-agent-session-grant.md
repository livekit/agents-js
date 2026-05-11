---
'@livekit/agents': patch
---

Require the `can_manage_agent_session` grant for remote session participants. `RoomSessionTransport` now authorizes inbound and outbound session messages based on each remote participant's permission rather than a single linked identity, and responses are routed back to the originating sender. Ported from livekit/agents#5487.
