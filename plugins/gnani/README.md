<!--
SPDX-FileCopyrightText: 2026 LiveKit, Inc.

SPDX-License-Identifier: Apache-2.0
-->

# agents-plugin-gnani

[Gnani Vachana](https://gnani.ai/) plugin for [LiveKit Agents](https://docs.livekit.io/agents/).

Provides speech-to-text (STT) for Indian languages using Gnani's Vachana API.

## Installation

```bash
pnpm add @livekit/agents-plugin-gnani
```

## Usage

```typescript
import * as gnani from '@livekit/agents-plugin-gnani';

const stt = new gnani.STT({
  language: 'hi-IN',
});
```

Set the `GNANI_API_KEY` environment variable or pass `apiKey` directly.

For REST recognition, `GNANI_ORGANIZATION_ID` and `GNANI_USER_ID` may also be set or passed directly.

## Supported Languages

Bengali (`bn-IN`), English India (`en-IN`), Gujarati (`gu-IN`), Hindi (`hi-IN`), Kannada (`kn-IN`), Malayalam (`ml-IN`), Marathi (`mr-IN`), Punjabi (`pa-IN`), Tamil (`ta-IN`), Telugu (`te-IN`).

Streaming also supports code-switching language codes `en-hi-IN-latn` and `en-hi-in-cm`.
