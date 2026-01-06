---
'@livekit/agents-plugin-google': patch
'@livekit/agents': patch
---

fix(google): handle late-arriving toolCalls in Gemini realtime API

When using the Gemini realtime API, tool calls could occasionally arrive after `turnComplete`, causing them to be lost or trigger errors. This fix keeps the `functionChannel` open after `turnComplete` to catch late-arriving tool calls, and adds a `closed` property to `StreamChannel` to track channel state.

No code changes required for consumers.
