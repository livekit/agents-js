<!--
SPDX-FileCopyrightText: 2026 LiveKit, Inc.

SPDX-License-Identifier: Apache-2.0
-->

# NVIDIA plugin for LiveKit Agents

Support for [NVIDIA Riva](https://developer.nvidia.com/riva) speech AI services in LiveKit Agents.

## Installation

```bash
pnpm add @livekit/agents-plugin-nvidia
```

## Prerequisites

Use an NVIDIA API key through `NVIDIA_API_KEY`, or connect to a self-hosted
[NIM](https://developer.nvidia.com/nim) server with `useSsl: false`.

## Usage

```typescript
import * as nvidia from '@livekit/agents-plugin-nvidia';

const stt = new nvidia.STT();
const tts = new nvidia.TTS();
```

For a local NIM deployment, pass its gRPC address to `server` and disable SSL.

TTS reuses pooled gRPC channels. The last session using a provider releases its idle
channels; active synthesis finishes before its channel closes. STT releases its channel
after each recognition attempt. For standalone use, call `close()` after all streams finish.

TTS keeps one logical audio segment per stream. `flush()` sends pending text;
`endInput()` ends the segment. A failed sentence is logged and skipped so later
sentences can still play. If every sentence fails, the stream emits a nonrecoverable
error so a fallback provider can take over. `synthesize()` sends one request per
sentence of the complete text. It retries only when no audio was produced, and never
retries a request rejected for bad input or credentials.

STT reconnects after transport failures and unexpected server closure. Audio already
sent to the failed connection is not replayed. An utterance open when a connection
fails stays open until the next connection's final transcript ends it. Word timestamps
remain on the stream clock, and usage metrics count the audio sent on each connection.

Transcripts include word-level timestamps. Set `enableDiarization: true` with a
Sortformer-based model, such as the default model, to label final transcripts with a
speaker ID (`S<tag>`). Each word also carries its own speaker ID, so mixed-speaker
transcripts keep word-level attribution. `maxSpeakerCount` limits the number of speakers.

Authentication metadata is sent only over TLS, matching the Python Riva client.

## Protocol definitions

NVIDIA does not publish a Node.js Riva client. This plugin calls the Riva gRPC API
directly. `@grpc/proto-loader` loads the protocol files at runtime; there is no
code-generation step.

The files in `proto/riva/proto/` are trimmed copies of NVIDIA's MIT-licensed definitions
from [`nvidia-riva/common`](https://github.com/nvidia-riva/common). They keep only the
messages, fields and RPCs this plugin uses. The field numbers match
`nvidia-riva-client` 2.16.0, the client used by the Python plugin.

To use a new Riva field:

1. Copy the field from the upstream `.proto` file. Keep its field number exactly.
2. Add the field to the matching type in `src/proto.ts`.

A wrong field number does not cause an error. The server ignores the field or reads it
as a different field.
