---
'@livekit/agents': patch
'@livekit/agents-plugin-openai': patch
'@livekit/agents-plugin-google': patch
'@livekit/agents-plugin-xai': patch
---

Run realtime and full-duplex voice models through LiveKit Inference: `inference.RealtimeModel` for OpenAI Realtime, Gemini Live, and Grok Voice, and `inference.DuplexModel` (or `llm: 'openai/gpt-live-1'`) for OpenAI GPT-Live. The OpenAI Realtime and GPT-Live clients move into agents core; `openai.realtime.RealtimeModel` and `openai.realtime.GPTLiveModel` keep working with direct OpenAI credentials. Gemini 3.x `generateReply` instructions are sent as a wrapped user turn instead of a trailing model turn the model continued. `GrokRealtimeModels` replaces `grok-voice-think-fast-2.0` with `grok-voice-3.0` and `grok-voice-latest`. OpenAI Realtime sessions now retry a refused or failed WebSocket handshake instead of crashing or ending the session, resample and downmix input that isn't 24 kHz mono, and keep a committed turn's trailing audio out of the next turn.
