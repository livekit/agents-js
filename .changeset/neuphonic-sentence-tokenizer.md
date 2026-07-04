---
'@livekit/agents-plugin-neuphonic': patch
---

Batch streamed text into sentences before sending it to the Neuphonic websocket (matching the Python plugin), with a configurable `tokenizer` option. This also anchors TTS TTFB on the first sentence sent to the provider instead of the first LLM token.
