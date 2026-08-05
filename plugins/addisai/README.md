<!--
SPDX-FileCopyrightText: 2026 LiveKit, Inc.

SPDX-License-Identifier: Apache-2.0
-->

# AddisAI plugin for LiveKit Agents

This package adds AddisAI speech-to-text and text-to-speech to LiveKit Agents
for Node.js. Both services support Amharic (`am`) and Afaan Oromo (`om`).

## Installation

```bash
npm install @livekit/agents-plugin-addisai
```

Set your AddisAI API key:

```bash
export ADDIS_API_KEY="your-api-key"
```

## Usage

```ts
import { AgentSession } from '@livekit/agents';
import * as addisai from '@livekit/agents-plugin-addisai';

const session = new AgentSession({
  stt: new addisai.STT({ language: 'am' }),
  llm: yourLLM,
  tts: new addisai.TTS({
    language: 'am',
    voice: 'am-hamen',
  }),
});
```

### Speech-to-text

```ts
const recognizer = new addisai.STT({ language: 'om' });
```

AddisAI STT uses the batch `addis-whisper` endpoint and returns final
transcripts. In a voice pipeline, use a VAD so LiveKit can segment incoming
speech and adapt it to batch recognition.

### Text-to-speech

```ts
const synthesizer = new addisai.TTS({
  language: 'om',
  voice: 'your-available-oromo-voice-id',
  speed: 1,
});
```

Addis Voices 2 does not stream partial audio. The plugin requests WAV-wrapped
16 kHz PCM and LiveKit automatically adapts complete generations into the voice
pipeline. Voice availability is dynamic; query the AddisAI voice catalog and
use an available ID matching the selected language.

The provider `client_request_id` remains stable across retries to prevent
duplicate generation and billing, while every LiveKit output attempt receives
a fresh request ID so partial failed audio can be discarded safely.

## Additional resources

- [AddisAI speech-to-text documentation](https://docs.addisassistant.com/docs/capabilities/speech-to-text)
- [AddisAI text-to-speech documentation](https://docs.addisassistant.com/docs/capabilities/text-to-speech)
- [LiveKit Agents documentation](https://docs.livekit.io/agents/)
