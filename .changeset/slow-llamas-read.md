---
'@livekit/agents': patch
'@livekit/agents-plugin-baseten': patch
'@livekit/agents-plugin-google': patch
'@livekit/agents-plugin-mistralai': patch
'@livekit/agents-plugin-openai': patch
---

fix(llm): raise the default streaming request timeout to 30s while keeping it configurable through connection options
