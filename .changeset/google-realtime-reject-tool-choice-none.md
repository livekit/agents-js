---
'@livekit/agents-plugin-google': patch
---

Emulate `toolChoice: 'none'` in the Gemini Live realtime model. The Google Realtime API has no per-response tool choice, so the model could still emit a tool call on a turn that asked for none — for example the reply that delivers an async tool result, or the final reply after the max tool steps. Those calls were dropped without a `functionResponse`, leaving the call outstanding: the model waited on a result that never arrived, and because microphone input is held back while a tool call is pending, the session stopped hearing the participant for the rest of the call.

Tool calls emitted while `toolChoice` is `'none'` are now answered with an error response telling the model to reply directly, without executing the tool and without opening a generation. Repeat offenders are cut off after three rejections in a turn so a model that keeps calling tools cannot loop.
