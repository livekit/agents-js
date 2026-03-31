---
'@livekit/agents-plugin-google': patch
---

fix: compatibility with gemini-3.1-flash-live-preview (#1179)

Two paths were broken with Gemini 3.1:

1. **`pushAudio()`** — was sending `mediaChunks` (deprecated); now sends the `audio` field directly, which Gemini 3.1 requires.

2. **`generateReply()`** — was using `sendClientContent` to trigger generation; Gemini 3.1 rejects this with "Request contains an invalid argument." Now uses `sendRealtimeInput({ text })` instead, which works across all Live API models.

Also fixes spurious empty `tools` field being sent when there are no declarations. Restores session resumption opt-in: always sends `sessionResumption: {}` on first connect (so the server enables tracking and sends `sessionResumptionUpdate` events), and includes the handle on subsequent connects.
