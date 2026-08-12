<!--
SPDX-FileCopyrightText: 2026 Gandr

SPDX-License-Identifier: Apache-2.0
-->
# Gandr plugin for LiveKit Agents

Gandr text to speech for [LiveKit Agents](https://github.com/livekit/agents). This
package contains the Gandr TTS plugin, which speaks the OpenAI-compatible
`POST /v1/audio/speech` endpoint Gandr mounts at `https://tts.gandr.ai/v1`.

```bash
pnpm add @livekit/agents-plugin-gandr
```

```typescript
import * as gandr from '@livekit/agents-plugin-gandr';

const session = new voice.AgentSession({
  tts: new gandr.TTS({ voice: 'gandr-mia' }), // key from GANDR_API_KEY
  // ... llm, stt, vad, turnHandling, etc.
});
```

Get a key at [gandr.ai](https://gandr.ai). The free tier is 100,000 tokens.

## Voices

`gandr-mia`, `gandr-ava`, `gandr-jenny`, `gandr-dane`, `gandr-leo`,
`gandr-lewis`, or a `gnd:` clone id. The OpenAI voice names (`alloy`, `echo`,
`fable`, `onyx`, `nova`, `shimmer`, `ash`, `ballad`, `coral`, `sage`, `verse`)
alias onto those voices automatically, so an unmodified OpenAI client pointed at
`baseURL` also gets audio. Swap mid-session with
`session.tts.updateOptions({ voice: 'gandr-ava' })`.

## Behaviour worth knowing

- **Streams in chunks as it is generated**, so playback starts while the rest is
  still rendering. The plugin requests `response_format: 'pcm'` (headerless
  s16le) which LiveKit plays directly; the endpoint's own default format would
  need an encoder the doors do not ship, so an explicit format is always sent.
- **Errors map to the framework exception classes**: a 4xx or 5xx raises
  `APIStatusError`, a dead connection raises `APIConnectionError`, and a
  timeout raises `APITimeoutError`, so `FallbackAdapter` and LiveKit's retry
  handling take over the same way they do for the other providers.
- `speed` maps to the Gandr speed knob (0.6 to 1.5, pitch preserving). Values
  outside that range are clamped by the door.

## Accuracy

Word error rate 1.982% against a 2.171% human reference, scored by one
`whisper-large-v3` configuration across everything including the human baseline,
n=1,088. Numbers, dates and order IDs are read correctly rather than
approximated, which is the failure that actually breaks phone agents.

Every render carries an inaudible watermark.

Apache-2.0.
