<!--
SPDX-FileCopyrightText: 2026 LiveKit, Inc.

SPDX-License-Identifier: Apache-2.0
-->

# Google Cloud plugin for LiveKit Agents

The Agents Framework is designed for building realtime, programmable
participants that run on servers. Use it to create conversational, multi-modal
voice agents that can see, hear, and understand.

This package contains the Google Cloud plugin, which provides text-to-speech
via the [Google Cloud Text-to-Speech API](https://cloud.google.com/text-to-speech).

## Installation

```bash
pnpm add @livekit/agents-plugin-google-cloud
```

## Authentication

Credentials are resolved by the underlying `@google-cloud/text-to-speech` client in order:

1. `credentials` object passed directly (`{ client_email, private_key }`)
2. `keyFilename` path to a service account JSON key file
3. `GOOGLE_APPLICATION_CREDENTIALS` environment variable
4. Application Default Credentials (auto-detected by `gcloud auth`)

## Usage

```typescript
import { TTS } from '@livekit/agents-plugin-google-cloud';

// Streaming synthesis (gRPC, default)
const tts = new TTS({
  language: 'en-US',
  voiceName: 'en-US-Standard-H',
});

// Non-streaming synthesis (REST)
const tts = new TTS({
  language: 'en-IN',
  voiceName: 'en-IN-Standard-C',
  streaming: false,
});

// Streaming synthesis
const stream = tts.stream();
stream.pushText('Hello, world!');
stream.flush();
for await (const event of stream) {
  // event.frame contains AudioFrame data
}
```

## License

Apache 2.0
