# @livekit/agents-plugin-blaze

LiveKit Agent Framework plugin for Blaze AI services:

- **STT (Speech-to-Text)**: `POST /v1/stt/transcribe` (batch only)
- **TTS (Text-to-Speech)**: `POST /v1/tts/realtime` (streaming PCM)
- **LLM (Conversational AI)**: `POST /voicebot/{botId}/chat-conversion?stream=true` (SSE streaming)

## Install

```bash
npm i @livekit/agents-plugin-blaze
```

## Quick start

```ts
import { STT, TTS, LLM } from '@livekit/agents-plugin-blaze';

// Reads BLAZE_* env vars by default
const stt = new STT({ language: 'vi' });
const tts = new TTS({ speakerId: 'speaker-1' });
const llm = new LLM({ botId: 'my-chatbot-id' });
```

## Environment variables

```bash
# Required for authenticated deployments
export BLAZE_API_URL=https://api.blaze.vn
export BLAZE_API_TOKEN=your-bearer-token

# Optional timeouts
export BLAZE_STT_TIMEOUT=30000
export BLAZE_TTS_TIMEOUT=60000
export BLAZE_LLM_TIMEOUT=60000
```

## Notes

- STT streaming is **not** supported (the plugin throws if `stream()` is called).
- LLM supports SSE streaming; `system/developer` messages are converted into user context as `"[System]: ..."`.

