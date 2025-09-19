<!--
SPDX-FileCopyrightText: 2025 LiveKit, Inc.

SPDX-License-Identifier: Apache-2.0
-->

# @livekit/agents-plugin-upliftai

UpliftAI TTS plugin for LiveKit Node Agents.

## Installation

```bash
npm install @livekit/agents-plugin-upliftai
```

## Usage

```typescript
import { TTS } from '@livekit/agents-plugin-upliftai';

// Initialize TTS with your API key
const tts = new TTS({
  apiKey: 'your-api-key', // or set UPLIFTAI_API_KEY environment variable
  voiceId: 'v_meklc281', // optional, defaults to v_meklc281
});


## Configuration

### Environment Variables

- `UPLIFTAI_API_KEY`: Your UpliftAI API key
- `UPLIFTAI_BASE_URL`: Base URL for the UpliftAI API (defaults to `wss://api.upliftai.org`)

## License

Apache-2.0