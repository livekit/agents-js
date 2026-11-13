---
'@livekit/agents': patch
---

Settle answering machine detection as `uncertain` with reason `participant_disconnected` when the callee hangs up while AMD is listening. Before this change, the hangup settled through session close, either with reason `session_closed` or with a held verdict for a callee who was gone. A held `machine-unavailable` verdict is still returned.
