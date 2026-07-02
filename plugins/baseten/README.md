<!--
SPDX-FileCopyrightText: 2024 LiveKit, Inc.

SPDX-License-Identifier: Apache-2.0
-->

# LiveKit Agents Baseten Plugin

Node.js/TypeScript plugin for LiveKit Agents with Baseten-hosted models (LLM, STT, TTS).

## Installation

```bash
cd packages/livekit-plugin-baseten
pnpm install
pnpm build
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
import { LLM } from 'livekit-plugin-baseten'

const llm = new LLM({
    model: 'openai/gpt-4o-mini',
    apiKey: process.env.BASETEN_API_KEY
})
```

### STT

```typescript
import { STT } from 'livekit-plugin-baseten'

const stt = new STT({
    apiKey: process.env.BASETEN_API_KEY,
    modelId: process.env.BASETEN_STT_MODEL_ID
})

const stream = stt.stream()
for await (const event of stream) {
    // Handle speech events
}
```

### TTS

```typescript
import { TTS } from 'livekit-plugin-baseten'

const tts = new TTS({
    apiKey: process.env.BASETEN_API_KEY,
    modelEndpoint: 'your-model-endpoint-url'
})

const stream = tts.synthesize('Hello world')
for await (const frame of stream) {
    // Process audio frames
}
```

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
