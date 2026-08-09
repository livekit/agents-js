---
'@livekit/agents-plugin-openai': patch
---

fix(openai): keep a Responses stream retryable until it emits generation

`retryable` was cleared by every event the HTTP stream processed, including events that
emit no chunk at all. `response.created` opens every stream, so a Responses request went
unretryable from its first event regardless of provider — a mid-stream stall then failed
the turn outright with nothing generated and nothing for a retry to duplicate. The
WebSocket path had the mirror defect: it never cleared `retryable`, so a socket dropping
after text had already streamed retried and regenerated it.

Both paths now clear `retryable` on text or a tool call, the output a retry would actually
repeat. The phase marker and the usage-bearing completion event are not.
