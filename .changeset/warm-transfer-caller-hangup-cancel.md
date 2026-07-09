---
'@livekit/agents': patch
---

fix(workflows): cancel a warm transfer when the caller hangs up before the merge. `WarmTransferTask` now watches the caller room from `onEnter`: if the caller disconnects while the human agent's phone is still ringing or during the briefing, the pending SIP dial is aborted, the human agent room is torn down (ending the call), and the task completes with a `ToolError` — instead of the human agent being connected into an empty room.
