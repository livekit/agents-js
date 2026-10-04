---
'@livekit/agents': patch
'@livekit/agents-plugin-anam': patch
'@livekit/agents-plugin-bey': patch
---

Stop tagging participant, avatar, and room identifiers in log records as `lk.pii.*`, matching the Python SDK. Content fields (transcripts, tool arguments, chat context) stay tagged. Span attributes are unchanged.
