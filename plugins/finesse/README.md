<!--
SPDX-FileCopyrightText: 2026 LiveKit, Inc.

SPDX-License-Identifier: Apache-2.0
-->

# Finesse plugin for LiveKit Agents

The Agents Framework is designed for building realtime, programmable
participants that run on servers. Use it to create conversational, multi-modal
voice agents that can see, hear, and understand.

This package contains the [Finesse](https://finesse.flamapp.ai) plugin by Flam, which provides
realtime text-to-speech in 60 languages, including 22 Indian languages, in voices from the catalog
or your own cloned voices.
Refer to the [documentation](https://docs.livekit.io/agents/overview/) for
information on how to use it.
See the [repository](https://github.com/livekit/agents-js) for more information
about the framework as a whole.

## Installation

```bash
pnpm add @livekit/agents-plugin-finesse
```

## Usage

Set `FINESSE_API_KEY` in your environment, or pass `apiKey`. Create a key in the
[Finesse dashboard](https://finesse.flamapp.ai/dashboard) under **Settings → API keys**.

```typescript
import { voice } from '@livekit/agents';
import * as finesse from '@livekit/agents-plugin-finesse';

const session = new voice.AgentSession({
  tts: new finesse.TTS({ voice: '<voice-id>', language: 'hi' }),
  // ... stt, llm, etc.
});
```

`voice` is the id of a ready voice: copy it from **Voices** in the dashboard, or list voices with
the [Finesse API](https://docs.finesse.flamapp.ai/voice-api/list-voices). Pass `language` as a
Finesse language code, for example `hi`, `ta`, `ory` (Odia) or `arz` (Egyptian Arabic).

`stream()` sends the agent's text to Finesse as the LLM writes it and plays the audio (24 kHz mono
PCM by default) as it arrives. When the user interrupts, the reply is cancelled on the Finesse
server straight away. Connections are pooled across replies, and `prewarm()` opens one before the
first reply. Each open connection holds one of your plan's concurrent streams.

| Option          | Default              | Notes                                                                          |
| --------------- | -------------------- | ------------------------------------------------------------------------------ |
| `voice`         | required             | id of a ready Finesse voice, including cloned voices                           |
| `language`      | `en`                 | Finesse language code; region subtags such as `hi-IN` work                     |
| `sampleRate`    | `24000`              | 24000 (native) to 48000 Hz                                                     |
| `numStep`       | server default (32)  | 1-32, quality vs latency                                                       |
| `guidanceScale` | server default (2.0) | 0-10                                                                           |
| `lengthScale`   | server default (1.0) | speaking rate, greater than 0 up to 5; higher is slower                        |
| `idleFlushMs`   | server default (800) | 200-5000 ms; speak a pending partial sentence after this long without new text |
