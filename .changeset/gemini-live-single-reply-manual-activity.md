---
'@livekit/agents-plugin-google': patch
---

With manual activity detection, `generateReply()` no longer sends a `turnComplete` after ending an open user activity unless it carries instructions: ending the activity already asks Gemini to reply, and the extra request started a second generation that cut the first one off.
