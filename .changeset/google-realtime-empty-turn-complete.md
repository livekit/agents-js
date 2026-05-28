---
'@livekit/agents-plugin-google': patch
---

fix(google): surface empty Gemini realtime turnComplete as recoverable error

Gemini's Live API occasionally emits a `turnComplete` with no audio, no
text, and no tool calls (upstream bug
[googleapis/python-genai#2117](https://github.com/googleapis/python-genai/issues/2117)),
leaving the agent in `speaking` state with nothing to play. The realtime
plugin now emits a recoverable `APIStatusError` on those turns so the
upstream `AgentActivity` can retry, matching the intent of the Python
sibling fix in [livekit/agents#4249](https://github.com/livekit/agents/pull/4249).
Tool-call-only turns and turns with any audio or text output are
unaffected. Closes [#1450](https://github.com/livekit/agents-js/issues/1450).
