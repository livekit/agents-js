---
"@livekit/agents-plugin-openai": patch
---

fix(openai): forward session.update on RealtimeSession.updateOptions

`RealtimeSession.updateOptions()` compared against the shared `RealtimeModel._options`, but the same call mutated that shared object before forwarding to sessions. The diff always saw "no change" and no `session.update` was sent to OpenAI.

Give each `RealtimeSession` its own `_options` copy so the per-session diff is independent of the model-level state and of any other sessions sharing the same model.

Ports [livekit/agents#5531](https://github.com/livekit/agents/pull/5531).
