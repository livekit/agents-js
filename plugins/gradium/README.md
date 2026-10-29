# agents-plugin-gradium

[Gradium](https://gradium.ai/) plugin for [LiveKit Agents](https://docs.livekit.io/agents/).

Provides speech-to-text (STT) and text-to-speech (TTS) integrations for Gradium-hosted models.

## Installation

```bash
pnpm add @livekit/agents-plugin-gradium
```

## Usage

```typescript
import * as gradium from '@livekit/agents-plugin-gradium';

const stt = new gradium.STT();
const tts = new gradium.TTS();
```

Set the `GRADIUM_API_KEY` environment variable or pass `apiKey` directly. To use a custom deployment, pass `modelEndpoint` or set `GRADIUM_MODEL_ENDPOINT`.
