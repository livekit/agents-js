# @livekit/agents-plugin-gnani

[LiveKit Agents](https://github.com/livekit/agents-js) plugin for **[Gnani](https://gnani.ai/)**: high-accuracy Speech-to-Text (Prisma) and low-latency Text-to-Speech (Timbre) for Indian languages.

> [Gnani.ai](https://gnani.ai) featuring **Prisma** (STT) and **Timbre** (TTS) models, supporting 10+ Indian languages with real-time streaming, multilingual transcription, and code-switching capabilities.

## Installation

```bash
pnpm add @livekit/agents-plugin-gnani
```

## Prerequisites

You need a Gnani API key. Email **[speechstack@gnani.ai](mailto:speechstack@gnani.ai)** to get started; all new accounts receive free credits, no credit card required.

### Authentication

All APIs require a single API key: no `organizationId` or `userId` needed.

**Option 1: Environment variable (recommended):**

```bash
export GNANI_API_KEY="your-api-key"
```

**Option 2: Constructor argument:**

```ts
const stt = new gnani.STT({ apiKey: 'your-api-key', language: 'hi-IN' });
const tts = new gnani.TTS({ apiKey: 'your-api-key' });
```

> **Migration note:** If upgrading from an earlier version, remove any `organizationId` and `userId` parameters; they are no longer accepted.

## Quick Start

### Speech-to-Text (REST + Streaming)

```ts
import * as gnani from '@livekit/agents-plugin-gnani';

const stt = new gnani.STT({ language: 'hi-IN' });

// REST STT (file-based transcription)
const speechEvent = await stt.recognize(audioBuffer);

// Streaming STT (real-time WebSocket)
const speechStream = stt.stream();
```

### Text-to-Speech

```ts
import * as gnani from '@livekit/agents-plugin-gnani';

// REST (default): single-request batch synthesis
const ttsRest = new gnani.TTS({ voice: 'Karan' });

// SSE: chunked synthesis via Server-Sent Events (lower latency)
const ttsSse = new gnani.TTS({ voice: 'Karan', synthesizeMethod: 'sse' });

// WebSocket: chunked synthesis over WS (lowest latency)
const ttsWs = new gnani.TTS({ voice: 'Karan', synthesizeMethod: 'websocket' });
```

All three modes work with the standard LiveKit voice agent pipeline. The `synthesizeMethod` controls which transport `synthesize()` uses (REST, SSE, or WebSocket). The `stream()` method always uses WebSocket regardless of this setting.

## Full Constructor Reference

### STT: All Parameters

```ts
const stt = new gnani.STT({
  language: 'en-IN', // Default: 'en-IN'
  sampleRate: 16000, // Default: 16000 (also: 8000)
  format: 'verbatim', // Default: 'verbatim' (also: 'transcribe')
  preferredLanguage: undefined, // Default: undefined
  itnNativeNumerals: false, // Default: false
  apiKey: undefined, // Default: reads GNANI_API_KEY env var
  baseURL: 'https://api.vachana.ai', // Default
});
```

### TTS: All Parameters

```ts
const tts = new gnani.TTS({
  voice: 'Karan', // Default: 'Karan' (also: Simran, Nara, Riya, Viraj, Raju)
  model: 'vachana-voice-v3', // Default: 'vachana-voice-v3'
  sampleRate: 16000, // Default: 16000 (also: 8000, 22050, 44100)
  encoding: 'linear_pcm', // Only supported encoding
  container: 'wav', // Default: 'wav' (also: 'raw')
  numChannels: 1, // Default: 1
  bitrate: undefined, // Default: undefined (also: '96k', '128k', '192k')
  synthesizeMethod: 'rest', // Default: 'rest' (also: 'sse', 'websocket')
  apiKey: undefined, // Default: reads GNANI_API_KEY env var
  baseURL: 'https://api.vachana.ai', // Default
});
```

## Features

### STT (Prisma)

- **REST recognition**: REST API (`POST /stt/v3`) for file-based transcription
- **Real-time streaming**: WebSocket API (`wss://api.vachana.ai/stt/v3/stream`) for live audio transcription with VAD
- **10+ Indian languages**: see [supported language codes](https://docs.gnani.ai/api/STT/stt-websocket#supported-languages)
- **Code-switching**: supports multilingual and code-mixed audio
- **Sample rates**: 8 kHz and 16 kHz
- **ITN support**: Inverse Text Normalization via `format: 'transcribe'`

#### Streaming PCM Specification

All streaming audio must be sent as **raw PCM binary frames**: no container format (WAV, MP3) mid-stream.

| Property            | 16 kHz                                  | 8 kHz                                   |
| ------------------- | --------------------------------------- | --------------------------------------- |
| Encoding            | PCM signed 16-bit little-endian         | PCM signed 16-bit little-endian         |
| Sample Rate         | 16,000 Hz                               | 8,000 Hz                                |
| Channels            | 1 (mono)                                | 1 (mono)                                |
| Samples per chunk   | 512                                     | 512                                     |
| **Bytes per frame** | **1,024 bytes** (512 samples x 2 bytes) | **1,024 bytes** (512 samples x 2 bytes) |
| Frame duration      | 32 ms                                   | 64 ms                                   |

Frames must be sent at **real-time cadence**. See **[STT Realtime: PCM Specification](https://docs.gnani.ai/api/STT/stt-websocket#pcm-specification)** for full details.

### TTS (Timbre)

- **REST synthesis**: single-request batch audio generation (`synthesizeMethod: 'rest'`)
- **SSE streaming**: lower-latency chunked synthesis via Server-Sent Events (`synthesizeMethod: 'sse'`)
- **WebSocket synthesis**: lowest-latency synthesis via `synthesizeMethod: 'websocket'` or the `stream()` method
- **6 voices**: Karan, Simran, Nara, Riya, Viraj, Raju
- **Decoded output**: linear PCM in raw or WAV containers; encoded formats aren't supported
- **Configurable output**: sample rate (8000-44100), raw or WAV container, and optional bitrate
- **Runtime updates**: change voice or model via `updateOptions()`

## Supported Languages

### STT Languages (Prisma)

Prisma uses BCP-47 locale codes (e.g. `hi-IN`). Supported:

- **[STT REST: Supported Languages](https://docs.gnani.ai/api/STT/speech-to-text#supported-languages)**
- **[STT Realtime: Supported Languages](https://docs.gnani.ai/api/STT/stt-websocket#supported-languages)**

### TTS Languages (Timbre)

For the full list of supported languages, see **[TTS: Supported Languages](https://docs.gnani.ai/api/TTS/tts-inference#supported-languages)**.

## Available Voices

| Voice  | ID       | Gender | Description              |
| ------ | -------- | ------ | ------------------------ |
| Karan  | `Karan`  | Male   | Bold, Trustworthy        |
| Simran | `Simran` | Female | Confident, Bright        |
| Nara   | `Nara`   | Female | Gentle, Expressive       |
| Riya   | `Riya`   | Female | Cheerful, Energetic      |
| Viraj  | `Viraj`  | Male   | Commanding, Dynamic      |
| Raju   | `Raju`   | Male   | Grounded, Conversational |

## Architecture

This plugin directly implements the Gnani REST, SSE, and WebSocket APIs using `fetch` and `ws`, adapting them into LiveKit's `stt.STT` and `tts.TTS` base classes. It uses the **Prisma** model for speech-to-text and the **Timbre** model for text-to-speech. No external SDK is required; all connection logic, authentication, and audio format handling is self-contained. Authentication uses a single `apiKey` passed via the `X-API-Key-ID` header.

## Documentation

- [Gnani API Docs](https://docs.gnani.ai/)
- [LiveKit Agents Docs](https://docs.livekit.io/agents/)
- [Gnani STT Plugin Guide](https://docs.livekit.io/agents/integrations/stt/gnani/)
- [Gnani TTS Plugin Guide](https://docs.livekit.io/agents/integrations/tts/gnani/)

## License

Apache-2.0
