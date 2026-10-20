---
'@livekit/agents': patch
'@livekit/agents-plugin-cartesia': patch
'@livekit/agents-plugin-elevenlabs': patch
'@livekit/agents-plugin-fishaudio': patch
'@livekit/agents-plugin-inworld': patch
'@livekit/agents-plugin-minimax': patch
'@livekit/agents-plugin-neuphonic': patch
'@livekit/agents-plugin-resemble': patch
'@livekit/agents-plugin-rime': patch
---

Add `tokenize.blingfire.SentenceTokenizer` (backed by `@livekit/blingfire`) and make it the default sentence tokenizer, matching the Python agents. The framework TTS adapters now also retain formatting like Python.
