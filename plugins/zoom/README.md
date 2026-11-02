<!--
SPDX-FileCopyrightText: 2026 LiveKit, Inc.

SPDX-License-Identifier: Apache-2.0
-->

# Zoom AI plugin for LiveKit Agents

Support for [Zoom Scribe](https://developers.zoom.us/docs/ai-services/scribe/) speech-to-text in two modes:

- **Live** ([docs](https://developers.zoom.us/docs/ai-services/scribe/live-mode/)): streaming over WebSocket. Scribe's own VAD ends each speech turn and returns its final transcript.
- **Fast** ([docs](https://developers.zoom.us/docs/ai-services/scribe/fast-mode/)): one HTTP request per utterance. It is not streaming, so `AgentSession` pairs it with a VAD.

See [zoom.ai](https://www.zoom.ai/) for all Zoom AI Services APIs and features.

## Installation

```bash
pnpm add @livekit/agents-plugin-zoom
```

## Pre-requisites

Create a Zoom AI Services API key in [Zoom Platform Studio](https://platform.zoom.us/) under Credentials > API Keys, with the Scribe permissions. Set it in your environment:

```shell
ZOOM_AI_API_KEY=<your_zoom_api_key>
```

## Usage

### Scribe Live (streaming)

Scribe detects the end of each turn, so let the STT drive turn detection:

```ts
import { voice } from '@livekit/agents';
import * as zoom from '@livekit/agents-plugin-zoom';

const session = new voice.AgentSession({
  stt: new zoom.STT({ language: 'en-US' }),
  turnHandling: { turnDetection: 'stt' },
  // ... llm, tts, etc.
});
```

### Scribe Fast (per utterance)

```ts
import { voice } from '@livekit/agents';
import * as zoom from '@livekit/agents-plugin-zoom';

const session = new voice.AgentSession({
  stt: new zoom.STT({ mode: 'fast' }),
  // Add a VAD to cut audio into utterances.
  // ... llm, vad, tts, etc.
});
```

For standalone transcription, a longer `silenceDurationMs` such as `600` keeps sentences with pauses together and can improve accuracy. The `350` ms default is tuned for voice agents.

Fast recognition accepts per-request language, connection, and cancellation options:

```ts
const event = await stt.recognize(frames, {
  language: 'fr-FR',
  connOptions: { maxRetry: 2, retryIntervalMs: 500, timeoutMs: 10_000 },
  abortSignal: controller.signal,
});
```

For custom networking, pass `httpSession` with an injected `fetch` and/or `wsConnect` implementation.

## Options

Options map to the Scribe API fields of the same name. See the [Scribe docs](https://developers.zoom.us/docs/ai-services/scribe/) for feature availability. Pass fields without a dedicated option through `extraKwargs`.

| Option              | Default            | Description                                                                                             |
| ------------------- | ------------------ | ------------------------------------------------------------------------------------------------------- |
| `mode`              | `'live'`           | `'live'` (streaming) or `'fast'` (one request per utterance)                                            |
| `apiKey`            | `$ZOOM_AI_API_KEY` | Zoom AI Services API key                                                                                |
| `language`          | `'en-US'`          | Recognition language; an unlisted regional variant uses its base language's locale (`en-GB` to `en-US`) |
| `model`             | `undefined`        | Recognition model; omitted to use Scribe's default                                                      |
| `languageDetection` | `undefined`        | Language detection mode; Live supports `'continuous'`                                                   |
| `silenceDurationMs` | `350`              | Live silence that ends a turn; `null` uses Scribe's default                                             |
| `diarization`       | `false`            | Speaker labels in `speakerId`, or `metadata.speaker_segments` for multiple speakers                     |
| `wordTimeOffsets`   | `false`            | Fast word timings in `words`                                                                            |
| `channelSeparation` | `false`            | Fast stereo channel recognition with segments in `metadata.channel_segments`                            |
| `vocabulary`        | `undefined`        | Words and phrases to recognize                                                                          |
| `textPolishing`     | `false`            | Polished text, with the recognized text in `metadata.transcript`                                        |
| `extraKwargs`       | `{}`               | Additional Scribe request fields, deeply merged over the dedicated options                              |
| `baseUrl`           | Zoom Scribe API    | Base URL used to derive Live and Fast endpoints                                                         |
| `liveUrl`           | derived            | Override the Scribe Live WebSocket URL                                                                  |
| `fastUrl`           | derived            | Override the Scribe Fast HTTP URL                                                                       |
| `httpSession`       | native transports  | Inject custom `fetch` and/or `wsConnect` implementations                                                |
