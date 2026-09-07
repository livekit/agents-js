<!--
SPDX-FileCopyrightText: 2026 LiveKit, Inc.

SPDX-License-Identifier: Apache-2.0
-->

# Speechify plugin for LiveKit Agents

The Agents Framework is designed for building realtime, programmable
participants that run on servers. Use it to create conversational, multi-modal
voice agents that can see, hear, and understand.

This package contains the Speechify plugin, which provides streaming
text-to-speech with word-level timestamps. Refer to the
[documentation](https://docs.livekit.io/agents/overview/) for information on how
to use it.

See the [repository](https://github.com/livekit/agents-js) for more information
about the framework as a whole.

## Installation

```bash
pnpm add @livekit/agents-plugin-speechify
```

## Usage

Set the `SPEECHIFY_API_KEY` environment variable (or pass `apiKey` to the
constructor), then:

```ts
import * as speechify from '@livekit/agents-plugin-speechify';

const tts = new speechify.TTS({ voiceId: 'dominic_32', model: 'simba-3.2' });
```

Synthesis uses the Speechify `/v1/audio/speech` endpoint, which returns raw PCM
(24 kHz mono) plus word-level speech marks. `stream()` chunks input into
sentences and issues one request per sentence, emitting audio and aligned word
timestamps as each sentence completes. Every request is attributed to this
integration via `Speechify-Caller: livekit-typescript` and
`Speechify-Caller-Version` (the plugin's release).
