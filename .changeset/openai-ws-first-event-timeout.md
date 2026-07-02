---
'@livekit/agents-plugin-openai': patch
---

Add a receive-side (first-event / inactivity) timeout to the OpenAI Responses WebSocket LLM. Previously, if a `response.create` was sent but the server (or an intermediary gateway) left the socket open and silent, the receive loop blocked forever — no watchdog, and retries never engaged because nothing threw. The persistent WS now aborts the turn with a retryable `APIConnectionError` (reconnecting on the next turn) when no event arrives within `responseTimeoutMs` of the request, or when the gap between two consecutive events exceeds it. Configurable via the new `responseTimeoutMs` option (default 15000 ms; set to `0` to disable). Also ports two robustness features from the Python plugin: a parallel-generation guard that resets the stored `previous_response_id` continuation chain when turns overlap, and a retryable error when the receive loop drains without a completed response.
