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
// The default model is voxtral-mini-transcribe-realtime-3.
// Pass a batch model for offline transcription.
const stt = new mistral.STT({ model: 'voxtral-mini-transcribe-3' });

// With context biasing
const stt = new mistral.STT({
  model: 'voxtral-mini-transcribe-3',
  contextBias: ['LiveKit', 'Voxtral', 'Mistral'],
});

// The larger batch model
const stt = new mistral.STT({ model: 'voxtral-small-transcribe-3', language: 'en' });
```

#### Realtime streaming transcription

Voxtral 3 (`voxtral-mini-transcribe-realtime-3`) has server-side turn detection. It is
enabled by default and can be tuned with `turnDetection`.

```ts
// Server-side turn detection with the server defaults (the default model)
const stt = new mistral.STT({ language: 'en' });

// Tuned turn detection
const stt = new mistral.STT({
  model: 'voxtral-mini-transcribe-realtime-3',
  turnDetection: { minSilenceMs: 400, endTimeoutMs: 1500 },
});
```

Pass `turnDetection: null` to let the voice pipeline decide when a turn ends. Set the
session's `turnHandling.turnDetection` to `'stt'` to use the speech boundaries detected by
the server.

Earlier realtime models, Voxtral 3 with `turnDetection: null`, and Voxtral 3 with
`diarize: true` have no server-side endpointing. An `AgentSession` flushes the plugin from
its own VAD. Outside an `AgentSession`, call `stream.flush()` when the user stops speaking.

Pass a `vad` to have the plugin flush and emit start/end-of-speech events itself. A VAD
replaces Voxtral 3 server turn detection and cannot be used together with an explicit
`turnDetection` setting.

```ts
import * as silero from '@livekit/agents-plugin-silero';

const stt = new mistral.STT({
  model: 'voxtral-mini-transcribe-realtime-2602',
  vad: await silero.VAD.load(),
});
```

#### Speaker diarization

`diarize: true` labels transcripts and segments (`words`) with `speakerId`. Batch models
and Voxtral 3 realtime support diarization; earlier realtime models do not. Voxtral 3
cannot use diarization with server turn detection, so turn detection is disabled by
default when diarization is enabled. Supply a VAD if the session uses STT turn detection.

```ts
const batchStt = new mistral.STT({
  model: 'voxtral-small-transcribe-3',
  diarize: true,
});

const realtimeStt = new mistral.STT({
  model: 'voxtral-mini-transcribe-realtime-3',
  diarize: true,
});
```

Realtime speaker numbering restarts after each flush, so speaker IDs cannot be compared
across transcripts. Realtime transcripts do not include timestamps.

#### Updating options

`stt.updateOptions()` accepts `model`, `language`, `contextBias`,
`targetStreamingDelayMs`, `diarize`, and `turnDetection`. Batch changes apply to the next
transcription. Realtime session changes reconnect active streams and lose unfinished
transcription. A model can only be changed to another model of the same batch or realtime
kind.

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
