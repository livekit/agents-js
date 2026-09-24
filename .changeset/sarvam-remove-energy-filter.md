---
'@livekit/agents-plugin-sarvam': patch
---

Send all audio frames to Sarvam instead of filtering quiet frames locally, preserving silence for server-side endpointing. Provider usage can increase because quiet audio is now sent.
