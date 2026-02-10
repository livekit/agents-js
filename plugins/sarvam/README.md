# agents-plugin-sarvam

[Sarvam AI](https://www.sarvam.ai/) plugin for [LiveKit Agents](https://docs.livekit.io/agents/).

Provides text-to-speech (TTS) using Sarvam AI's Bulbul models with support for 11 Indian languages.

## Installation

```bash
pnpm add @livekit/agents-plugin-sarvam
```

## Usage

```typescript
import * as sarvam from '@livekit/agents-plugin-sarvam';

const tts = new sarvam.TTS({
  speaker: 'anushka',
  model: 'bulbul:v2',
  targetLanguageCode: 'en-IN',
});
```

Set the `SARVAM_API_KEY` environment variable or pass `apiKey` directly.

## Supported Languages

Bengali (`bn-IN`), English (`en-IN`), Gujarati (`gu-IN`), Hindi (`hi-IN`), Kannada (`kn-IN`), Malayalam (`ml-IN`), Marathi (`mr-IN`), Odia (`od-IN`), Punjabi (`pa-IN`), Tamil (`ta-IN`), Telugu (`te-IN`).
