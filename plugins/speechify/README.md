<!--
SPDX-FileCopyrightText: 2026 LiveKit, Inc.

SPDX-License-Identifier: Apache-2.0
-->

# Speechify plugin for LiveKit Agents

The Agents Framework is designed for building realtime, programmable
participants that run on servers. Use it to create conversational, multi-modal
voice agents that can see, hear, and understand.

This package contains the [Speechify](https://speechify.ai) plugin, which provides streaming
text-to-speech with word-level timestamps.
Refer to the [documentation](https://docs.livekit.io/agents/overview/) for
information on how to use it.
See the [repository](https://github.com/livekit/agents-js) for more information
about the framework as a whole.

## Installation

```bash
pnpm add @livekit/agents-plugin-speechify
```

## Usage

Set `SPEECHIFY_API_KEY` in your environment, or pass `apiKey`. Get a key at
[platform.speechify.ai](https://platform.speechify.ai).

```typescript
import { voice } from '@livekit/agents';
import * as speechify from '@livekit/agents-plugin-speechify';

const session = new voice.AgentSession({
  tts: new speechify.TTS({ voiceId: 'dominic_32', model: 'simba-3.2' }),
  // ... stt, llm, etc.
});
```

`simba-3.2` is English only and has the lowest time to first audio; use `simba-3.0` for the other
languages it supports. The voice must support the model; list voices with `GET /v1/voices`.

`stream()` splits its input into sentences and synthesizes each one as soon as it is complete,
over `POST /v1/audio/stream/with-timestamps`. Audio (24 kHz mono PCM) and word timestamps are
forwarded as they arrive, so captions stay aligned with speech. Requests share keep-alive
connections, which `prewarm()` opens before the first reply.
