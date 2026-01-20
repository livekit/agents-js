<!--
SPDX-FileCopyrightText: 2025 LiveKit, Inc.

SPDX-License-Identifier: Apache-2.0
-->
# NVIDIA Riva Plugin for LiveKit Agents

This plugin provides NVIDIA Riva Speech-to-Text (STT) and Text-to-Speech (TTS) capabilities for LiveKit Agents.

## Installation

```bash
npm install @livekit/agents-plugin-nvidia
# or
pnpm add @livekit/agents-plugin-nvidia
```

## Configuration

Set your NVIDIA API key as an environment variable:

```bash
export NVIDIA_API_KEY=your_api_key_here
```

## Usage

### Speech-to-Text (STT)

```typescript
import * as nvidia from '@livekit/agents-plugin-nvidia';

const stt = new nvidia.STT({
  model: 'parakeet-1.1b-en-US-asr-streaming-silero-vad-sortformer',
  languageCode: 'en-US',
});
```

### Text-to-Speech (TTS)

```typescript
import * as nvidia from '@livekit/agents-plugin-nvidia';

const tts = new nvidia.TTS({
  voice: 'Magpie-Multilingual.EN-US.Leo',
  languageCode: 'en-US',
});
```

## Options

### STT Options

- `model`: The ASR model to use (default: `'parakeet-1.1b-en-US-asr-streaming-silero-vad-sortformer'`)
- `functionId`: NVIDIA function ID (default: `'1598d209-5e27-4d3c-8079-4751568b1081'`)
- `punctuate`: Enable automatic punctuation (default: `true`)
- `languageCode`: Language code (default: `'en-US'`)
- `sampleRate`: Audio sample rate (default: `16000`)
- `server`: NVIDIA Riva server address (default: `'grpc.nvcf.nvidia.com:443'`)
- `useSsl`: Use SSL for connection (default: `true`)
- `apiKey`: NVIDIA API key (defaults to `NVIDIA_API_KEY` environment variable)

### TTS Options

- `voice`: Voice name (default: `'Magpie-Multilingual.EN-US.Leo'`)
- `functionId`: NVIDIA function ID (default: `'877104f7-e885-42b9-8de8-f6e4c6303969'`)
- `languageCode`: Language code (default: `'en-US'`)
- `sampleRate`: Audio sample rate (default: `16000`)
- `server`: NVIDIA Riva server address (default: `'grpc.nvcf.nvidia.com:443'`)
- `useSsl`: Use SSL for connection (default: `true`)
- `apiKey`: NVIDIA API key (defaults to `NVIDIA_API_KEY` environment variable)

## License

Apache-2.0
