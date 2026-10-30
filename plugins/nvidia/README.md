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
