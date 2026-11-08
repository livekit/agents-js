<!--
SPDX-FileCopyrightText: 2026 LiveKit, Inc.

SPDX-License-Identifier: Apache-2.0
-->

# Vartaloop plugin for LiveKit Agents

The Agents Framework is designed for building realtime, programmable
participants that run on servers. Use it to create conversational, multi-modal
voice agents that can see, hear, and understand.

This package contains the [Vartaloop](https://api.vartaloop.ai) plugin, which provides
Hinglish and Indian-language text-to-speech. Refer to the
[documentation](https://docs.livekit.io/agents/overview/) for information on how to use the
framework, or browse the [API reference](https://docs.livekit.io/agents-js/modules/plugins_agents_plugin_vartaloop.html).
See the [repository](https://github.com/livekit/agents-js) for more information about the
framework as a whole.

## Installation

```bash
pnpm add @livekit/agents-plugin-vartaloop
```

## Usage

```typescript
import * as vartaloop from '@livekit/agents-plugin-vartaloop';

const tts = new vartaloop.TTS({
  voice: 'saanvi',
  expression: 'neutral',
  digits: 'auto',
});
```

Set the `VARTALOOP_API_KEY` environment variable or pass `apiKey` directly.

`stream()` cuts the text into sentences as the LLM produces it and sends each one as its own
utterance over a pooled WebSocket; the server queues them in order, so the next sentence is
synthesised while the current one plays. `synthesize()` is one HTTP request per text whose audio
is forwarded as it arrives. Both produce 16-bit PCM mono at 24 kHz.

Every option travels with each utterance, so `tts.updateOptions({ voice: 'sahil' })` applies from
the next sentence on without reconnecting.

## Options

| Option         | Default                      | Description                                                                                                                 |
| -------------- | ---------------------------- | --------------------------------------------------------------------------------------------------------------------------- |
| `voice`        | `'saanvi'`                   | Voice id. The voice decides the language: Hinglish text to a Hinglish voice, English text to an English one.                |
| `expression`   | `'neutral'`                  | `neutral`, `excited`, `sad` or `whisper`. A voice without the expression plays neutral.                                     |
| `digits`       | `'auto'`                     | How digits are read by Hinglish voices: `auto`, `hi`, `mixed` (codes in English, amounts in Hindi) or `en`.                 |
| `speed`        | voice's own pace             | Speaking pace, 0.5 to 2.0.                                                                                                  |
| `temperature`  | server default (0.3)         | Sampling noise, 0 to 2.                                                                                                     |
| `seed`         | unset                        | Fixes the sampling noise for reproducible output.                                                                           |
| `postfx`       | server default (on)          | The server's output chain: loudness to -16 LUFS, high-pass, true-peak limiter.                                              |
| `profile`      | `'default'`                  | `default` or `telephony` (shaped for 8 kHz mu-law delivery).                                                                |
| `raw`          | `false`                      | Skip the server's text normaliser.                                                                                          |
| `model`        | `'narad'`                    | Model family, named in metrics and logs; the API has no model field.                                                        |
| `sampleRate`   | `24000`                      | Output sample rate; the API produces 24 kHz, so this must be 24000.                                                         |
| `apiKey`       | `$VARTALOOP_API_KEY`         | The API key.                                                                                                                |
| `baseUrl`      | `'https://api.vartaloop.ai'` | The API base URL.                                                                                                           |
| `chunkTimeout` | `10000`                      | Milliseconds to wait for the next WebSocket message of an utterance in flight before the turn is retried on a fresh socket. |
