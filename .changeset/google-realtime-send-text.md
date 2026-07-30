---
'@livekit/agents-plugin-google': minor
---

Add `RealtimeSession.sendText()` to the Google plugin for sending a text turn as realtime input. Unlike `generateReply()`, this works with models that do not support mid-session client content updates (e.g. `gemini-3.1` live models): the text is delivered via the Live API's `send_realtime_input({ text })` and treated by the model as a completed user turn. Under manual activity detection the text is wrapped in activity markers so it forms a complete turn.
