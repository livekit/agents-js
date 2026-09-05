<!--
SPDX-FileCopyrightText: 2024 LiveKit, Inc.

SPDX-License-Identifier: Apache-2.0
-->

# LiveKit Agents Baseten Plugin

Node.js/TypeScript plugin for LiveKit Agents with Baseten-hosted models (LLM, STT, TTS).

## Installation

```bash
pnpm add @livekit/agents-plugin-baseten
```

## Configuration

Create `.env` file:

```bash
BASETEN_API_KEY=your_api_key_here
BASETEN_MODEL_ID=your_llm_model_id
BASETEN_TTS_MODEL_ID=your_tts_model_id
BASETEN_STT_MODEL_ID=your_stt_model_id
```

## Usage

### LLM

```typescript
import { LLM } from '@livekit/agents-plugin-baseten';

const llm = new LLM({
  model: 'openai/gpt-4o-mini',
  apiKey: process.env.BASETEN_API_KEY,
});
```

### STT

```typescript
import { STT } from '@livekit/agents-plugin-baseten';

const stt = new STT({
  apiKey: process.env.BASETEN_API_KEY,
  modelId: process.env.BASETEN_STT_MODEL_ID,
  audioLanguage: 'auto',
  languageOptions: ['en', 'de'],
});

const stream = stt.stream();
for await (const event of stream) {
  // Handle speech events
}
```

### TTS

```typescript
import { TTS } from '@livekit/agents-plugin-baseten';

const tts = new TTS({
  apiKey: process.env.BASETEN_API_KEY,
  modelEndpoint: 'your-model-endpoint-url',
});

const stream = tts.synthesize('Hello world');
for await (const frame of stream) {
  // Process audio frames
}
```

## Qwen3 STT and TTS

Baseten's Qwen3 deployments use different WebSocket protocols from Whisper and Orpheus.
Select them through the same public `STT` and `TTS` classes:

```typescript
import { STT, TTS } from '@livekit/agents-plugin-baseten';

const stt = new STT({
  model: 'qwen3-asr',
  modelId: 'your-qwen3-asr-model-id',
});

const tts = new TTS({
  model: 'qwen3-tts',
  modelId: 'your-qwen3-tts-model-id',
  voice: 'your-registered-voice',
});
```

Qwen3-ASR defaults to automatic language selection, 500 ms VAD silence, 100 ms speech
padding, and no word timestamps. Set `wordTimestamps: true` only when the deployment has
the MMS stream aligner enabled.

Qwen3-TTS Base has no built-in speakers. Register a 10-20 second clean reference clip, or
list the clones available on the connected replica:

```typescript
import { listVoices, registerVoice } from '@livekit/agents-plugin-baseten';

await registerVoice({
  modelEndpoint: 'wss://model-<id>.api.baseten.co/environments/production/websocket',
  name: 'my-voice',
  refAudioPath: './reference.wav',
  refText: 'Transcript of the reference audio.',
});

const voices = await listVoices({ modelEndpoint: 'wss://...' });
```

Uploaded voices live on one replica and are lost when it restarts. Bake required voices
into multi-replica deployments, or use `refAudio` and `refText` for inline cloning.

## Testing

```bash
pnpm test:llm-cli   # Interactive LLM chat
pnpm test:tts-cli   # TTS synthesis
pnpm test:stt-cli   # STT with microphone
```

See [TESTING.md](./test/TESTING.md) for details.

## Development

```bash
pnpm build      # Build
pnpm dev        # Watch mode
pnpm typecheck  # Type checking
pnpm lint       # Linting
```
