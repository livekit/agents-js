---
'@livekit/agents-plugin-assemblyai': patch
---

Reject changes to `redactPii`, `redactPiiPolicies`, `redactPiiSub`, and `includePartialTurns` in `updateOptions`, so open streams cannot emit unredacted word text or misreport `interimResults` before they reconnect.
