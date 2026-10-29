<!--
SPDX-FileCopyrightText: 2026 LiveKit, Inc.
SPDX-License-Identifier: Apache-2.0
-->

# AddisAI plugin for LiveKit Agents

AddisAI batch STT, live Scribe, Addis Voices 2 TTS, and conversational realtime
for LiveKit Agents on Node.js.

## Installation

```bash
npm install @livekit/agents-plugin-addisai
export ADDIS_API_KEY="your-api-key"
```

## Voice pipeline

```ts
import { AgentSession } from '@livekit/agents';
import * as addisai from '@livekit/agents-plugin-addisai';

const session = new AgentSession({
  stt: new addisai.STT({ language: 'am' }),
  llm: yourLLM,
  tts: new addisai.TTS({ language: 'am', voice: 'am-hamen' }),
});
```

`STT` uses the legacy batch endpoint for Amharic (`am`), Afaan Oromo (`om`),
and Tigrinya (`ti`). Use a VAD to segment turns.

## Addis Scribe

Use current Amharic file and live transcription with interim results:

```ts
const stt = new addisai.ScribeSTT({ backend: 'turbo', chunk: '320ms' });
```

Scribe creates a scoped, one-use ticket for each live utterance and accepts 16
kHz mono PCM. `speakers: true` requires the Turbo backend and retains labelled
provider results in transcript metadata.

## Addis Voices 2

`TTS` returns completed clips. Voice IDs are dynamic and must match `am`, `om`,
or `ti`.

```ts
const tts = new addisai.TTS({ language: 'om', voice: 'om-bikila' });
```

Use a persistent token-in/audio-out socket with:

```ts
const tts = new addisai.StreamingTTS({ language: 'am', voice: 'am-hamen' });
```

The streaming adapter creates a scoped ticket, uses one stable request ID, and
consumes `speech.completed` to confirm the saved clip and billing settlement.

## Conversational realtime

The microphone-conversation relay is a separate service from streaming TTS:

```ts
import { llm } from '@livekit/agents';

const model = new llm.DuplexRealtimeAdapter(new addisai.RealtimeModel());
```

It accepts 16 kHz PCM, returns 24 kHz PCM, and owns turn detection and
interruptions. The current public relay protocol does not expose custom
instructions, chat history, tools, or transcripts.

## Resources

- [Scribe live transcription](https://docs.addisassistant.com/docs/capabilities/speech-to-text/live)
- [Streaming speech](https://docs.addisassistant.com/docs/capabilities/text-to-speech/streaming)
- [Conversational realtime](https://docs.addisassistant.com/docs/capabilities/realtime)
- [Node.js SDK](https://github.com/Addis-AI-Org/addisai-js)
- [LiveKit Agents](https://docs.livekit.io/agents/)
