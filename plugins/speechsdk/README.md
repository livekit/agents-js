<!--
SPDX-FileCopyrightText: 2026 LiveKit, Inc.

SPDX-License-Identifier: Apache-2.0
-->
# speech-sdk plugin for LiveKit Agents

The Agents Framework is designed for building realtime, programmable
participants that run on servers. Use it to create conversational, multi-modal
voice agents that can see, hear, and understand.

This package contains the [speech-sdk](https://github.com/Jellypod-Inc/speech-sdk)
plugin, which allows for voice synthesis across 15 TTS providers through a
single `provider/model` string, including providers without a dedicated
LiveKit plugin (Murf, Smallest.ai, and fal.ai-hosted open-weight models such
as Kokoro):

```ts
import * as speechsdk from '@livekit/agents-plugin-speechsdk';

const tts = new speechsdk.TTS({ model: 'openai/gpt-4o-mini-tts', voice: 'alloy' });
// or: { model: 'murf/FALCON', voice: 'en-US-amara' }
// or: { model: 'fal-ai/kokoro/american-english', voice: 'af_heart' }
```

Calls go directly to the selected provider using your own API key from the
provider's standard environment variable (`OPENAI_API_KEY`, `MURF_API_KEY`,
and so on). Optionally, setting `SPEECHBASE_API_KEY` routes the same
`provider/model` strings through [speechbase.ai](https://speechbase.ai), a
hosted gateway, so one key covers every provider; without it, calls go
directly to the provider.

Synthesis is non-streaming (`AgentSession` wraps it in a sentence-level
`StreamAdapter` automatically). For latency-critical production agents, a
dedicated provider plugin with native WebSocket streaming remains the better
choice when one exists; this plugin is useful for evaluating providers and
for reaching providers without a dedicated plugin. Output is delivered as raw
16-bit little-endian PCM (24 kHz by default; other native rates are
resampled).

See the [repository](https://github.com/livekit/agents-js) for more information
about the framework as a whole.
