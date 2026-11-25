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

Fix streaming TTS retries by replaying buffered input into isolated provider attempts, rebuilding one-shot provider state, and avoiding retries after audio has already been emitted or the stream was closed. Plugins that read their input once for the whole stream keep their own replay or resume, ElevenLabs sends nothing more to a context that failed or was interrupted, and Resemble retries connection failures that happen before audio.
