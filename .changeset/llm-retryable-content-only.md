---
'@livekit/agents': patch
---

fix(inference): keep a stream retryable until it emits generation

`retryable` was cleared by any chunk reaching the caller, including ones that carry no
output: a usage block, or provider metadata such as the LiveKit inference gateway's
deployment/tier stamp or a Gemini thought signature. The gateway stamps its leading
(contentless) delta, so every streamed response went unretryable from its first chunk — a
mid-stream stall then failed the turn outright rather than retrying, with nothing generated
and nothing for a retry to duplicate. Only failures landing before the very first chunk
still recovered.

`retryable` is now cleared on text or a tool call, the output a retry would actually repeat.
