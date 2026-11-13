---
'@livekit/agents': patch
---

Drop the sampling parameters gpt-6 rejects while it reasons, so a caller setting `temperature`, `top_p`, `presence_penalty`, `frequency_penalty`, `logit_bias`, `logprobs`, `top_logprobs` or `stop` on `openai/gpt-6.1-sol` no longer gets the API's 400 back. They come back at `reasoning_effort: "none"`, which gpt-6-sol and gpt-6-luna support. `n` and `seed` are accepted while reasoning and stay.
