<!--
SPDX-FileCopyrightText: 2026 LiveKit, Inc.

SPDX-License-Identifier: Apache-2.0
-->
# Fish Audio plugin for LiveKit Agents

The Agents Framework is designed for building realtime, programmable
participants that run on servers. Use it to create conversational, multi-modal
voice agents that can see, hear, and understand.

This package contains the Fish Audio plugin for voice synthesis and realtime
speech-to-text. Refer to the [Fish Audio documentation](https://docs.fish.audio)
for information on how to use it.

The plugin uses the Fish Audio Live TTS WebSocket API for streaming synthesis,
and the HTTP `/v1/tts` endpoint for one-shot synthesis. Output is delivered as
raw 16-bit little-endian PCM (24 kHz by default).

## Installation

```bash
pnpm add @livekit/agents-plugin-fishaudio
```

Set `FISH_API_KEY` in the environment, then configure either service:

```ts
import { voice } from '@livekit/agents';
import { STT, TTS } from '@livekit/agents-plugin-fishaudio';

const session = new voice.AgentSession({
  stt: new STT(),
  tts: new TTS(),
  // llm, vad, etc.
});
```

Fish Audio can detect the end of each user turn itself:

```ts
const session = new voice.AgentSession({
  stt: new STT(),
  turnHandling: { turnDetection: 'stt' },
  // llm, tts, etc.
});
```

See the [repository](https://github.com/livekit/agents-js) for more information
about the framework as a whole.
