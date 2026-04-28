<!--
SPDX-FileCopyrightText: 2026 LiveKit, Inc.

SPDX-License-Identifier: Apache-2.0
-->

# Mistral AI plugin for LiveKit Agents

The Agents Framework is designed for building realtime, programmable
participants that run on servers. Use it to create conversational, multi-modal
voice agents that can see, hear, and understand.

This package contains the Mistral AI plugin, providing LLM, STT, and TTS
capabilities via the official `@mistralai/mistralai` SDK.

## Installation

```bash
npm install @livekit/agents-plugin-mistralai
```

## Usage

### LLM

Uses the Mistral [Conversations API](https://docs.mistral.ai/capabilities/conversations/)
with stateful sessions and incremental context.

```ts
import * as mistral from '@livekit/agents-plugin-mistralai';

const llm = new mistral.LLM({
  model: 'mistral-small-latest',
  // apiKey defaults to process.env.MISTRAL_API_KEY
});
```

#### Provider tools

Mistral built-in tools can be attached directly to the LLM:

```ts
const llm = new mistral.LLM({
  model: 'mistral-small-latest',
  providerTools: [
    new mistral.WebSearch(),
    new mistral.CodeInterpreter(),
    new mistral.DocumentLibrary(['lib_abc123']),
  ],
});
```

### STT

Supports both batch transcription and realtime streaming (WebSocket).

```ts
// Batch transcription
const stt = new mistral.STT({ model: 'voxtral-mini-latest' });

// Realtime streaming (requires a VAD)
const stt = new mistral.STT({
  model: 'voxtral-mini-transcribe-realtime-2602',
});
```

Realtime models require a VAD for endpointing. If none is provided, Silero VAD
is loaded automatically (install `@livekit/agents-plugin-silero`).

### TTS

Text-to-speech with voice presets or reference audio for voice cloning.

```ts
const tts = new mistral.TTS({
  model: 'voxtral-mini-tts-latest',
  voice: 'en_paul_neutral',
});
```

### Environment variables

- `MISTRAL_API_KEY` ; Your Mistral API key (used by all components unless `apiKey` or `client` is passed explicitly)

### Supported models

See [`models.ts`](./src/models.ts) for the full list of chat, STT, TTS, and voice models.

