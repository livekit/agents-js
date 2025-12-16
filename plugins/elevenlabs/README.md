<!--
SPDX-FileCopyrightText: 2024 LiveKit, Inc.

SPDX-License-Identifier: Apache-2.0
-->
# ElevenLabs Plugin for LiveKit Agents

The Agents Framework is designed for building realtime, programmable
participants that run on servers. Use it to create conversational, multi-modal
voice agents that can see, hear, and understand.

This package contains the ElevenLabs plugin, which provides:
- **Text-to-Speech (TTS)**: High-quality voice synthesis with multiple voices and models
- **Speech-to-Text (STT)**: Real-time and batch transcription with Scribe API

Refer to the [documentation](https://docs.livekit.io/agents/overview/) for
information on how to use it, or browse the [API
reference](https://docs.livekit.io/agents-js/modules/plugins_agents_plugin_elevenlabs.html).
See the [repository](https://github.com/livekit/agents-js) for more information
about the framework as a whole.

## Installation

```bash
pnpm add @livekit/agents-plugin-elevenlabs
```

Set your ElevenLabs API key:
```bash
export ELEVEN_API_KEY=your_api_key_here
```

---

## Text-to-Speech (TTS)

For TTS documentation, refer to the [API reference](https://docs.livekit.io/agents-js/modules/plugins_agents_plugin_elevenlabs.html).

### Quick Example

```typescript
import { TTS } from '@livekit/agents-plugin-elevenlabs';

const tts = new TTS();
// Use tts for voice synthesis
```

---

## Speech-to-Text (STT)

### Features

- **Multiple Model Support**: Choose between Scribe v1, v2, and v2 realtime
- **Streaming & Non-Streaming**: Support for both batch and real-time transcription
- **Multi-Language**: Supports 35+ languages with automatic language detection
- **Audio Event Tagging**: Optional tagging of non-speech audio events (laughter, footsteps, etc.)
- **VAD Configuration**: Customizable voice activity detection for streaming mode

### Supported Models

#### Scribe v1 (`scribe_v1`)
- **Type**: Non-streaming
- **Method**: HTTP POST
- **Use Case**: Batch transcription of pre-recorded audio
- **Features**: Audio event tagging, language detection

#### Scribe v2 (`scribe_v2`)
- **Type**: Non-streaming
- **Method**: HTTP POST
- **Use Case**: Improved accuracy for batch transcription
- **Features**: Enhanced model, language detection

#### Scribe v2 Realtime (`scribe_v2_realtime`)
- **Type**: Streaming (default)
- **Method**: WebSocket
- **Use Case**: Real-time conversation transcription
- **Features**: Interim results, VAD-based segmentation, manual commit support

### Quick Start

#### Non-Streaming (Scribe v1)

```typescript
import { STT } from '@livekit/agents-plugin-elevenlabs';

const stt = new STT({
  apiKey: process.env.ELEVEN_API_KEY, // or set ELEVEN_API_KEY env var
  model: 'scribe_v1',
  languageCode: 'en',
  tagAudioEvents: true,
});
```

#### Streaming (Scribe v2 Realtime)

```typescript
import { STT } from '@livekit/agents-plugin-elevenlabs';
import { SpeechEventType } from '@livekit/agents';

const stt = new STT({
  model: 'scribe_v2_realtime',  // default
  sampleRate: 16000,
  languageCode: 'en',
  commitStrategy: 'vad', // auto-commit on speech end
  vadSilenceThresholdSecs: 1.0,
});
```

### Configuration Options

#### Common Options

| Option | Type | Default | Description |
|--------|------|---------|-------------|
| `apiKey` | `string` | `process.env.ELEVEN_API_KEY` | ElevenLabs API key |
| `baseURL` | `string` | `https://api.elevenlabs.io/v1` | API base URL |
| `model` | `STTModels` | `'scribe_v2_realtime'` | Model to use |
| `languageCode` | `string` | `undefined` | Language code (auto-detected if not set) |

#### Non-Streaming Options (v1, v2)

| Option | Type | Default | Description |
|--------|------|---------|-------------|
| `tagAudioEvents` | `boolean` | `true` | Tag non-speech events like (laughter) |

#### Streaming Options (v2_realtime)

| Option | Type | Default | Description |
|--------|------|---------|-------------|
| `sampleRate` | `number` | `16000` | Audio sample rate in Hz (16000, 22050, or 44100) |
| `numChannels` | `number` | `1` | Number of audio channels |
| `commitStrategy` | `'vad' \| 'manual'` | `'vad'` | How to commit transcripts |
| `vadSilenceThresholdSecs` | `number` | `undefined` | VAD silence threshold (0.3-3.0 seconds) |
| `vadThreshold` | `number` | `undefined` | VAD threshold (0.1-0.9) |
| `minSpeechDurationMs` | `number` | `undefined` | Minimum speech duration (50-2000 ms) |
| `minSilenceDurationMs` | `number` | `undefined` | Minimum silence duration (50-2000 ms) |

### Supported Languages

The STT plugin supports 35+ languages including:

English (`en`), Spanish (`es`), French (`fr`), German (`de`), Italian (`it`), Portuguese (`pt`), Polish (`pl`), Dutch (`nl`), Swedish (`sv`), Finnish (`fi`), Danish (`da`), Norwegian (`no`), Czech (`cs`), Romanian (`ro`), Slovak (`sk`), Ukrainian (`uk`), Greek (`el`), Turkish (`tr`), Russian (`ru`), Bulgarian (`bg`), Croatian (`hr`), Serbian (`sr`), Hungarian (`hu`), Lithuanian (`lt`), Latvian (`lv`), Estonian (`et`), Japanese (`ja`), Chinese (`zh`), Korean (`ko`), Hindi (`hi`), Arabic (`ar`), Persian (`fa`), Hebrew (`he`), Indonesian (`id`), Malay (`ms`), Thai (`th`), Vietnamese (`vi`), Tamil (`ta`), Urdu (`ur`)

### Advanced Usage

#### Custom VAD Parameters

Fine-tune voice activity detection for your use case:

```typescript
const stt = new STT({
  model: 'scribe_v2_realtime',
  commitStrategy: 'vad',

  // Longer silence before committing (good for thoughtful speakers)
  vadSilenceThresholdSecs: 2.0,

  // Higher threshold = more strict about what's considered speech
  vadThreshold: 0.7,

  // Ignore very short speech bursts (reduce false positives)
  minSpeechDurationMs: 200,

  // Require longer silence to end speech (reduce fragmentation)
  minSilenceDurationMs: 500,
});
```

#### Multi-Language Support

Let ElevenLabs auto-detect the language:

```typescript
const stt = new STT({
  model: 'scribe_v1',
  // Don't set languageCode - will auto-detect
});

const event = await stt.recognize(audioBuffer);
console.log('Detected language:', event.alternatives[0].language);
console.log('Text:', event.alternatives[0].text);
```

Or specify a language:

```typescript
const stt = new STT({
  model: 'scribe_v2_realtime',
  languageCode: 'es', // Spanish
});
```

### Model Comparison

| Feature | Scribe v1 | Scribe v2 | Scribe v2 Realtime |
|---------|-----------|-----------|-------------------|
| **Type** | Non-streaming | Non-streaming | Streaming |
| **Latency** | High (batch) | High (batch) | Low (real-time) |
| **Interim Results** | ❌ | ❌ | ✅ |
| **Audio Event Tagging** | ✅ | ❌ | ❌ |
| **VAD Configuration** | ❌ | ❌ | ✅ |
| **Manual Commit** | ❌ | ❌ | ✅ |
| **Best For** | Batch jobs with event detection | High-accuracy batch | Real-time conversations |

---

## Resources

- [ElevenLabs TTS Documentation](https://elevenlabs.io/docs/api-reference/text-to-speech)
- [ElevenLabs STT Documentation](https://elevenlabs.io/docs/api-reference/speech-to-text)
- [Scribe v2 Streaming Guide](https://elevenlabs.io/docs/cookbooks/speech-to-text/streaming)
- [LiveKit Agents Documentation](https://docs.livekit.io/agents/)
- [LiveKit Agents JS Repository](https://github.com/livekit/agents-js)

## License

Copyright 2025 LiveKit, Inc.

Licensed under the Apache License, Version 2.0.
