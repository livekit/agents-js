---
'@livekit/agents-plugin-rime': patch
---

Preserve acknowledged history appends after an explicit request refusal and report
the original error. Block requested replies until rejected tool results are supplied,
without resending accepted results or executing tools again. Keep session shutdown
for unknown outcomes and unsafe partial replacements.
