<!--
SPDX-FileCopyrightText: 2026 LiveKit, Inc.

SPDX-License-Identifier: Apache-2.0
-->

# Speko plugin for LiveKit Agents

The Agents Framework is designed for building realtime, programmable
participants that run on servers. Use it to create conversational, multi-modal
voice agents that can see, hear, and understand.

This package contains the Speko plugin for LiveKit Agents. Speko provides a
single STT, LLM, and TTS router for voice agents, selecting providers and
handling failover server-side so your LiveKit worker does not need separate
provider credentials.

## Installation

```sh
pnpm add @livekit/agents @livekit/agents-plugin-speko \
  @livekit/agents-plugin-silero @livekit/rtc-node
```

Set `SPEKO_API_KEY` in the environment before starting your worker.
If you need a non-default Speko API host, pass `baseURL` or set
`SPEKO_BASE_URL`.

## Usage

```ts
import {
  type JobContext,
  type JobProcess,
  ServerOptions,
  cli,
  defineAgent,
  voice,
} from '@livekit/agents';
import * as silero from '@livekit/agents-plugin-silero';
import * as speko from '@livekit/agents-plugin-speko';
import { fileURLToPath } from 'node:url';

export default defineAgent({
  prewarm: async (proc: JobProcess) => {
    proc.userData.vad = await silero.VAD.load();
  },
  entry: async (ctx: JobContext) => {
    const vad = ctx.proc.userData.vad as silero.VAD;
    const intent = {
      language: 'en-US',
      optimizeFor: 'balanced',
    } as const;

    const session = new voice.AgentSession({
      vad,
      stt: new speko.STT({ intent }),
      llm: new speko.LLM({ intent }),
      tts: new speko.TTS({ intent }),
    });

    await session.start({
      agent: new voice.Agent({
        instructions: 'You are a helpful voice assistant. Be concise.',
      }),
      room: ctx.room,
    });

    await ctx.connect();

    session.generateReply({
      instructions: 'Greet the user and offer your assistance.',
    });
  },
});

cli.runApp(
  new ServerOptions({
    agent: fileURLToPath(import.meta.url),
    agentName: 'speko-demo',
  }),
);
```

`intent` is required on each raw component because Speko uses it to route every
STT, LLM, and TTS call by language, region, and optimization preference.
`voice.AgentSession` automatically wraps non-streaming STT and TTS plugins with
LiveKit stream adapters when needed.

## Limitations

- STT is utterance-bounded. `speko.STT` uploads one VAD-bounded WAV per
  recognition call. Use `voice.AgentSession` with a VAD such as Silero, or wrap
  manually with `stt.StreamAdapter` if you implement a custom STT node.
- TTS is sentence-bounded. `voice.AgentSession` wraps `speko.TTS` with a
  sentence tokenizer by default, or you can wrap it manually with
  `tts.StreamAdapter` if you implement a custom TTS node.
- A Speko API key is required. Pass `apiKey`, set `SPEKO_API_KEY`, or pass a
  preconfigured SDK `client`.
- TTS output must be PCM or WAV. The plugin accepts `audio/pcm;rate=NNNN` and
  `audio/wav`; compressed formats such as MP3 are rejected.
