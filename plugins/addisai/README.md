<!--
SPDX-FileCopyrightText: 2026 LiveKit, Inc.

SPDX-License-Identifier: Apache-2.0
-->

# AddisAI plugin for LiveKit Agents

This package adds AddisAI speech-to-text and text-to-speech to LiveKit Agents
for Node.js. Both adapters support Amharic (`am`), Afaan Oromo (`om`), and
Tigrinya (`ti`).

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
  voice: 'om-bikila',
  speed: 1,
});
```

This adapter uses the Addis Voices 2 completed-clip API and requests WAV-wrapped
16 kHz PCM. AddisAI also offers native HTTP and WebSocket audio streaming;
these transport APIs are not yet implemented by this LiveKit adapter. Voice availability is dynamic; query the AddisAI voice catalog and
use an available ID matching the selected language.

The provider `client_request_id` remains stable across retries to prevent
duplicate generation and billing, while every LiveKit output attempt receives
a fresh request ID so partial failed audio can be discarded safely.

## Current API scope

For Tigrinya, use `language: 'ti'` with a matching voice such as
`voice: 'ti-berhane'`. The original `/api/v2/stt` endpoint remains documented.
The separate **Addis Scribe** API now offers Amharic live transcription and
partial updates. This initial plugin does not expose native Scribe WebSockets,
streamed TTS, or the AddisAI LLM/Realtime interfaces. These require dedicated
adapters and tests, particularly for paid-request recovery. The plugin uses
direct server-side HTTP rather than importing the official AddisAI JS SDK.

## Additional resources

- [AddisAI speech-to-text documentation](https://docs.addisassistant.com/docs/capabilities/speech-to-text)
- [AddisAI text-to-speech documentation](https://docs.addisassistant.com/docs/capabilities/text-to-speech)
- [LiveKit Agents documentation](https://docs.livekit.io/agents/)
- [Addis Scribe live transcription](https://docs.addisassistant.com/docs/capabilities/speech-to-text/live)
- [Addis Voices 2 streaming](https://docs.addisassistant.com/docs/capabilities/text-to-speech/streaming)
