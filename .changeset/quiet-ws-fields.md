---
'@livekit/agents-plugin-openai': patch
---

Handle top-level `code` and `param` fields on OpenAI Responses WebSocket error frames so request-validation errors surface cleanly and error-code routing (e.g. retry on `previous_response_not_found`) works for top-level codes.
