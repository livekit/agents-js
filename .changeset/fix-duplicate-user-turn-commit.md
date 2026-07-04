---
'@livekit/agents': patch
---

Fix duplicated user chat items in observability: a superseding EOU bounce created while an earlier bounce was mid-commit could fire after the transcript was already committed and cleared, committing a second empty user turn with stale metrics. The transcript guard is now re-checked at fire time. Also, session-report chat items now only upload string content (matching Python), so non-string content can no longer render as garbage in the dashboard.
