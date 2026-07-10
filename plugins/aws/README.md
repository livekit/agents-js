<!--
SPDX-FileCopyrightText: 2026 LiveKit, Inc.

SPDX-License-Identifier: Apache-2.0
-->

# AWS plugin for LiveKit Agents

The Agents Framework is designed for building realtime, programmable
participants that run on servers. Use it to create conversational, multi-modal
voice agents that can see, hear, and understand.

This package contains the AWS plugin, providing LLM (Amazon Bedrock Converse),
STT (Amazon Transcribe streaming), and TTS (Amazon Polly) capabilities via the
official AWS SDK v3 clients.

## Installation

```bash
npm install @livekit/agents-plugin-aws
```

## Credentials and region

All three components resolve AWS credentials via the AWS SDK v3 default
credential chain (environment variables, shared config/credentials files,
IMDS, container credentials, etc.) unless `credentials` is passed explicitly:

```ts
const llm = new aws.LLM({
  credentials: {
    accessKeyId: '...',
    secretAccessKey: '...',
    sessionToken: '...', // optional
  },
});
```

The region is resolved in this order: the `region` constructor option, then
`AWS_REGION`, then `AWS_DEFAULT_REGION`, falling back to `us-east-1`.

## Usage

### LLM

Uses the [Bedrock Converse API](https://docs.aws.amazon.com/bedrock/latest/userguide/conversation-inference.html)
with streaming.

```ts
import * as aws from '@livekit/agents-plugin-aws';

const llm = new aws.LLM({
  // model defaults to BEDROCK_INFERENCE_PROFILE_ARN if set, otherwise 'amazon.nova-2-lite-v1:0'
  model: 'anthropic.claude-3-5-sonnet-20241022-v2:0',
  region: 'us-east-1',
});
```

### STT

Streaming-only, via [Amazon Transcribe streaming](https://docs.aws.amazon.com/transcribe/latest/dg/streaming.html).
Single-frame (non-streaming) recognition is not supported.

```ts
const stt = new aws.STT({
  language: 'en-US',
  sampleRate: 24000,
});
```

Automatic language identification requires a companion `languageOptions` list
(comma-separated codes Amazon Transcribe should consider). AWS rejects the
request without it:

```ts
const stt = new aws.STT({
  identifyLanguage: true,
  languageOptions: 'en-US,es-US',
  preferredLanguage: 'en-US', // optional
});
```

### TTS

Uses [Amazon Polly](https://docs.aws.amazon.com/polly/latest/dg/API_SynthesizeSpeech.html).
Audio is requested as raw PCM (16-bit little-endian, mono) since the framework
has no MP3 decoder — Amazon Polly only supports PCM output at **8000 Hz or
16000 Hz**, so `sampleRate` is restricted to those two values (default
`16000`). Streaming synthesis is not supported.

```ts
const tts = new aws.TTS({
  voice: 'Ruth',
  speechEngine: 'generative',
  sampleRate: 16000,
});
```

### Environment variables

- `AWS_ACCESS_KEY_ID` / `AWS_SECRET_ACCESS_KEY` / `AWS_SESSION_TOKEN` — picked up by the default credential chain
- `AWS_REGION` / `AWS_DEFAULT_REGION` — region fallback when `region` isn't passed explicitly
- `BEDROCK_INFERENCE_PROFILE_ARN` — LLM model fallback when `model` isn't passed explicitly
