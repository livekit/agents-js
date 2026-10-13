---
'@livekit/agents-plugin-google': patch
---

Send Gemini 3.x `generateReply` instructions as a wrapped user turn instead of a trailing model turn, which these models continued instead of answering.
