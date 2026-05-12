---
'@livekit/agents-plugin-openai': patch
---

fix(openai): `LLM.withOllama` was using the OctoAI base URL and model; default to `http://localhost:11434/v1` and `llama3.1`
