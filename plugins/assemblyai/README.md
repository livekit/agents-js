<!--
SPDX-FileCopyrightText: 2026 LiveKit, Inc.

SPDX-License-Identifier: Apache-2.0
-->

# AssemblyAI plugin for LiveKit Agents

Support for Streaming Speech-to-Text and Streaming Text-to-Speech from AssemblyAI.

More information is available in the docs for the
[STT](https://docs.livekit.io/agents/integrations/stt/assemblyai/) integration and for
AssemblyAI's
[Streaming TTS](https://www.assemblyai.com/docs/tts/getting-started/quickstart).

## Installation

```bash
pnpm add @livekit/agents-plugin-assemblyai
```

## Pre-requisites

You'll need to specify an AssemblyAI API Key. It can be set as environment variable:
`ASSEMBLYAI_API_KEY`.

## Usage

```ts
import { voice } from '@livekit/agents';
import * as assemblyai from '@livekit/agents-plugin-assemblyai';

const session = new voice.AgentSession({
  stt: new assemblyai.STT({ speechModel: 'universal-3-6-pro', mode: 'balanced' }),
  tts: new assemblyai.TTS({
    model: 'assemblyai-tts-1',
    voice: '987db62e-a2c2-569a-9c4d-82460cdea1bd', // Keegan
  }),
  // Let AssemblyAI decide when the user has finished speaking.
  turnHandling: { turnDetection: 'stt' },
  // Use the TTS word timings for the transcript and for what an interrupted reply said.
  useTtsAlignedTranscript: true,
  // ... llm, vad, etc.
});
```

### Speech-to-text

`assemblyai.STT` streams Universal-3.6 Pro by default (`speechModel`). Useful options:

- `mode`: `"min_latency"`, `"balanced"` or `"max_accuracy"`.
- `languageCodes`: steer transcription toward one or more expected languages (`"es"` or
  `["en", "es"]`).
- `prompt`: context about the audio, such as its domain or scenario, to help recognize likely
  vocabulary (up to 1,750 characters).
- `keytermsPrompt`: names and terms the model should get right.

### Text-to-speech

`assemblyai.TTS` streams speech over a pooled WebSocket and cancels in-flight audio when the user
interrupts. Useful options:

- `voice`: a voice's id, from the [voice library](https://www.assemblyai.com/docs/tts/voices)
  or a custom (cloned) voice; defaults to Keegan. Slugs such as `"aai-linda-3"` also work, but
  can change, while ids don't.
- `language`: a code such as `"es"`, set independently of the voice.
- `model`: defaults to `assemblyai-tts-1`.
- `baseUrl`: the US data zone by default; `wss://tts.eu.assemblyai.com` keeps data in the EU.
- `wordTimestamps`: per-word timings (default `true`). With
  `AgentSession({ useTtsAlignedTranscript: true })`, LiveKit uses them to sync the transcript and to
  record an interrupted reply up to the word the user heard.

Call `tts.prewarm()` to open the session before the first reply.
