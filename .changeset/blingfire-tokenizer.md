---
'@livekit/agents': patch
'@livekit/agents-plugin-cartesia': patch
'@livekit/agents-plugin-resemble': patch
'@livekit/agents-plugin-deepgram': patch
'@livekit/agents-plugin-sarvam': patch
'@livekit/agents-plugin-fishaudio': patch
'@livekit/agents-plugin-inworld': patch
'@livekit/agents-plugin-minimax': patch
'@livekit/agents-plugin-rime': patch
'@livekit/agents-plugin-elevenlabs': patch
---

replace the basic tokenizer with @livekit/blingfire (tokenize.blingfire) for sentence and word tokenization, matching the python agents' blingfire tokenizer
