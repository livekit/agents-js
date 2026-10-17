<!--
SPDX-FileCopyrightText: 2026 LiveKit, Inc.

SPDX-License-Identifier: Apache-2.0
-->

# Nabrah plugin for LiveKit Agents

Support for [Nabrah](https://nabrah.ai/) Speech-to-Text in LiveKit Agents, with
client-side end-of-turn detection tuned for Arabic conversation.

## Installation

```bash
pnpm add @livekit/agents-plugin-nabrah
```

## Pre-requisites

You'll need an API key from Nabrah. It can be set as the `NABRAH_API_KEY`
environment variable.

## Usage

Use Nabrah STT in an `AgentSession`:

```ts
import { AgentSession } from '@livekit/agents';
import { STT } from '@livekit/agents-plugin-nabrah';

const session = new AgentSession({
  stt: new STT({
    recognitionModel: 'eot_nabrah',
    language: 'ar-SA',
    endOfTurnConfirmDelay: 400,
  }),
});
```

### Turn detection

`recognitionModel: 'eot_nabrah'` emits the end-of-turn signal the plugin uses to
close a turn. `endOfTurnConfirmDelay` is how long, in milliseconds, it waits
after that signal before committing. Speaking again inside the window keeps the
turn open. `maxTranscriptInactivity` optionally commits after that many
milliseconds without new transcript text. It is disabled by default because it
measures recognizer inactivity, not acoustic silence, and a provider delay could
otherwise split continuous speech.

Nabrah's unnamed model (`recognitionModel: ''`) is more accurate but emits no
end-of-turn signal. When using it, configure another turn detector or explicitly
set `maxTranscriptInactivity` as a fallback heuristic.

### Word boosting

Bias recognition toward terms the model gets wrong:

```ts
const stt = new STT({
  priorityWords: ['مستشفى الملك فيصل التخصصي', 'رقم الهوية الوطنية'],
  priorityWordsStrength: 0.5,
});
```

`0.5` is the recommended strength. Higher values make boosted terms appear in
places they were not said, so keep the list to terms your callers actually say
and add one only after hearing it come out wrong. Multi-word phrases are boosted
as a unit.

#### Loading terms from a file

For anything beyond a handful of terms, keep them in a JSON file so they can be
edited without touching code. Create `boosting.json` next to your agent:

```json
{
  "boostThreshold": 0.5,
  "words": ["مستشفى الملك فيصل التخصصي", "رقم الهوية الوطنية"]
}
```

Load it at startup and pass it to the plugin:

```ts
import { readFile } from 'node:fs/promises';

const boosting = JSON.parse(
  await readFile(new URL('./boosting.json', import.meta.url), 'utf8'),
) as { boostThreshold: number; words: string[] };

const stt = new STT({
  recognitionModel: 'eot_nabrah',
  language: 'ar-SA',
  endOfTurnConfirmDelay: 400,
  priorityWords: boosting.words,
  priorityWordsStrength: boosting.boostThreshold,
});
```

Read the file as UTF-8. Without it, Arabic terms can fail to load on platforms
that default to a different encoding.

## Full example

```ts
import {
  Agent,
  AgentSession,
  type JobContext,
  ServerOptions,
  cli,
  defineAgent,
  inference,
} from '@livekit/agents';
import { STT } from '@livekit/agents-plugin-nabrah';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

export default defineAgent({
  entry: async (ctx: JobContext) => {
    const boosting = JSON.parse(
      await readFile(new URL('./boosting.json', import.meta.url), 'utf8'),
    ) as { boostThreshold: number; words: string[] };

    const session = new AgentSession({
      stt: new STT({
        recognitionModel: 'eot_nabrah',
        language: 'ar-SA',
        endOfTurnConfirmDelay: 400,
        maxTranscriptInactivity: 1500,
        priorityWords: boosting.words,
        priorityWordsStrength: boosting.boostThreshold,
      }),
      llm: new inference.LLM({ model: 'openai/gpt-4.1-mini' }),
      tts: new inference.TTS({ model: 'cartesia/sonic-3' }),
      turnHandling: {
        turnDetection: 'stt',
        endpointing: { minDelay: 0 },
      },
    });

    await session.start({
      agent: Agent.create({ instructions: 'You are a helpful voice assistant.' }),
      room: ctx.room,
    });
    await ctx.connect();
  },
});

cli.runApp(new ServerOptions({ agent: fileURLToPath(import.meta.url) }));
```

## Parameters

| Parameter                 | Default          | Description                                                                                                                               |
| ------------------------- | ---------------- | ----------------------------------------------------------------------------------------------------------------------------------------- |
| `recognitionModel`        | `'eot_nabrah'`   | `'eot_nabrah'` emits the end-of-turn signal used for turn detection. `''` selects the more accurate default model, which emits no signal. |
| `endOfTurnConfirmDelay`   | `400`            | Hold in milliseconds after an end-of-turn signal before committing. `null` commits immediately.                                           |
| `maxTranscriptInactivity` | `null`           | Optional fallback in milliseconds that finalizes after no new transcript text. This does not measure acoustic silence.                    |
| `priorityWords`           | `[]`             | Terms to bias recognition toward.                                                                                                         |
| `priorityWordsStrength`   | `0.5`            | How strongly to bias.                                                                                                                     |
| `apiKey`                  | `NABRAH_API_KEY` | API key, if not set in the environment.                                                                                                   |
