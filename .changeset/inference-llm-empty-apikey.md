---
'@livekit/agents': patch
---

fix(inference): use non-empty placeholder for the internal OpenAI client's apiKey, which openai >= 6.36.0 rejects at construction (the value is replaced with a fresh access token before each request)
