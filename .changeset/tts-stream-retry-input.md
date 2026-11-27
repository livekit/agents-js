---
'@livekit/agents': patch
'@livekit/agents-plugin-cartesia': patch
'@livekit/agents-plugin-deepgram': patch
'@livekit/agents-plugin-elevenlabs': patch
'@livekit/agents-plugin-minimax': patch
'@livekit/agents-plugin-nvidia': patch
'@livekit/agents-plugin-resemble': patch
'@livekit/agents-plugin-rime': patch
'@livekit/agents-plugin-sarvam': patch
'@livekit/agents-plugin-soniox': patch
'@livekit/agents-plugin-speechify': patch
---

Replay buffered input when a streaming TTS attempt fails before audio. Release the buffer once the stream emits audio. Keep provider-owned retries for streams that manage their own input.

ElevenLabs stops sending to interrupted or failed contexts. Sarvam keeps a failed socket from ending the stream before retry. Resemble honors the configured retry budget for pre-audio connection failures.
