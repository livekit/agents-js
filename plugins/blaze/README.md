# @livekit/agents-plugin-blaze

LiveKit Agent Framework plugin for Blaze AI services:

- **STT (Speech-to-Text)**: batch `POST /v1/stt/transcribe` (default model `v2.0`) and realtime streaming via `stream()` → `WS /v1/stt/realtime` (default model `stt-stream-1.5`)
- **TTS (Text-to-Speech)**: `POST` / `WS` `/v1/tts/realtime` (default model `2.0-realtime`)
- **LLM (Conversational AI)**: `POST /v1/voicebot-call/{botId}/chat-conversion-stream` (SSE streaming)

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

- STT supports both batch recognition (`POST /v1/stt/transcribe`) and realtime streaming over WebSocket (`stream()` is supported).
- LLM supports SSE streaming; `system`/`developer` messages are skipped because the Blaze chatapp loads the voicebot prompt from the database.
