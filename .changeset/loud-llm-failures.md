---
'@livekit/agents': patch
---

Fail the reply when the LLM request fails: iterating an `LLMStream` now throws the request's final error, as in Python, so `session.run()` rejects and `SpeechHandle.exception()` is set instead of the turn ending with no text. An LLM nobody listens to for `error` events now retries and reports the provider's error instead of stopping at the first failure.
