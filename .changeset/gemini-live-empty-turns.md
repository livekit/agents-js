---
'@livekit/agents-plugin-google': patch
---

Send a bare `turnComplete` instead of an empty `turns` array when requesting a reply on Gemini Live models that take no placeholder user turn; the SDK rejected the empty array and the send task died, so `generateReply()` never produced a reply on `gemini-3.8-live`.
