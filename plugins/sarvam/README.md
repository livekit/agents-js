# agents-plugin-sarvam

[Sarvam AI](https://www.sarvam.ai/) plugin for [LiveKit Agents](https://docs.livekit.io/agents/).

Provides text-to-speech (TTS) using Sarvam AI's Bulbul models and speech-to-text (STT) using Saaras/Saarika models, with support for 22+ Indian languages.

## Installation

```bash
pnpm add @livekit/agents-plugin-sarvam
```

## Usage

### TTS

```typescript
import * as sarvam from '@livekit/agents-plugin-sarvam';

const tts = new sarvam.TTS({
  speaker: 'anushka',
  model: 'bulbul:v2',
  targetLanguageCode: 'en-IN',
});
```

### STT

```typescript
import * as sarvam from '@livekit/agents-plugin-sarvam';

const stt = new sarvam.STT({
  model: 'saaras:v3',
  languageCode: 'en-IN',
  mode: 'transcribe',
});
```

Set the `SARVAM_API_KEY` environment variable or pass `apiKey` directly.

## Supported Languages

### TTS (Bulbul models)

Bengali (`bn-IN`), English (`en-IN`), Gujarati (`gu-IN`), Hindi (`hi-IN`), Kannada (`kn-IN`), Malayalam (`ml-IN`), Marathi (`mr-IN`), Odia (`od-IN`), Punjabi (`pa-IN`), Tamil (`ta-IN`), Telugu (`te-IN`).

### STT (Saaras v3)

All TTS languages plus: Assamese (`as-IN`), Bodo (`brx-IN`), Dogri (`doi-IN`), Kashmiri (`ks-IN`), Konkani (`kok-IN`), Maithili (`mai-IN`), Manipuri (`mni-IN`), Nepali (`ne-IN`), Sanskrit (`sa-IN`), Santali (`sat-IN`), Sindhi (`sd-IN`), Urdu (`ur-IN`).

Set `languageCode` to `'unknown'` for automatic language detection.

## STT Modes (Saaras v3)

| Mode | Description |
|------|-------------|
| `transcribe` | Standard transcription with formatting and normalization (default) |
| `translate` | Direct speech-to-English translation |
| `verbatim` | Exact word-for-word transcription |
| `translit` | Romanization to Latin script |
| `codemix` | Mixed script (English words in English, Indic in native script) |
