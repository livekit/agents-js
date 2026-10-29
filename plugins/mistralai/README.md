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

Uses the Mistral [Conversations API](https://docs.mistral.ai/capabilities/conversations/).

```ts
import * as mistral from '@livekit/agents-plugin-mistralai';

const llm = new mistral.LLM({
  model: 'mistral-small-latest',
  // apiKey defaults to process.env.MISTRAL_API_KEY
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

The Voxtral 3 model (`voxtral-mini-tts-3`) is the default. By default, text is
synthesized over HTTP sentence by sentence, so speech starts when the first
sentence of an LLM reply is complete.

```ts
const tts = new mistral.TTS({
  model: 'voxtral-mini-tts-3',
  voice: 'en_paul_neutral',
});

// Voxtral 3 adds multilingual `voice_<n>` presets and accepts older voices.
// Older models only accept Voxtral 2 voices.
const multilingualTts = new mistral.TTS({
  model: 'voxtral-mini-tts-3',
  voice: 'voice_447', // Margaret, en-US
});

// Voxtral 3 supports expressiveness from 1 to 5 and IPA pronunciation hints.
const expressiveTts = new mistral.TTS({
  expressiveness: 3,
  phonemeHints: { tomato: ['t', 'ə', 'm', 'ɑ', 't', 'oʊ'] },
});
```

#### Realtime WebSocket

With `useRealtime: true`, speech is streamed over the realtime WebSocket API
while the LLM generates text, using a pool of connections reused between
requests. `phonemeHints` is not supported in this mode.

```ts
const tts = new mistral.TTS({ useRealtime: true });
```

Realtime speech is always PCM. Replies longer than the realtime engine's request
limit are split automatically.

### Environment variables

- `MISTRAL_API_KEY` ; Your Mistral API key (used by all components unless `apiKey` or `client` is passed explicitly)

### Supported models

See [`models.ts`](./src/models.ts) for the full list of chat, STT, TTS, and voice models.
