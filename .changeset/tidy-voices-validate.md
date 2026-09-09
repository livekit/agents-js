---
'@livekit/agents-plugin-assemblyai': patch
---

Validate live AssemblyAI options before mutating configuration, normalize regional language codes, and count and truncate agent context by Unicode code points. Model changes via updateOptions now fail explicitly; create a new STT instance to select a different model.
