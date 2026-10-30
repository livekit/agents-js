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

Call `close()` on each provider after its streams finish to release its gRPC channel.

TTS keeps one logical audio segment per stream. `flush()` sends pending text;
`endInput()` ends the segment. A failed sentence is logged and skipped so later
sentences can still play. If every sentence fails, the stream emits a nonrecoverable
error so a fallback provider can take over.

STT reconnects after transport failures and unexpected server closure. Audio already
sent to the failed connection is not replayed. Word timestamps remain on the stream
clock, and usage metrics count the audio sent on each connection.

Authentication metadata is sent only over TLS, matching the Python Riva client.
