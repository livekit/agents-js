<!--
SPDX-FileCopyrightText: 2026 LiveKit, Inc.

SPDX-License-Identifier: Apache-2.0
-->
# Mistral AI plugin for LiveKit Agents

The Agents Framework is designed for building realtime, programmable
participants that run on servers. Use it to create conversational, multi-modal
voice agents that can see, hear, and understand.

This package contains the Mistral AI plugin, which provides access to Mistral's
models (including `mistral-large-latest`, `mistral-small-latest`, and more)
via the official `@mistralai/mistralai` SDK. Refer to the
[documentation](https://docs.livekit.io/agents/overview/) for information on how
to use it.

## Usage

```ts
import { LLM } from '@livekit/agents-plugin-mistral';

const llm = new LLM({
  model: 'mistral-small-latest',
  // apiKey defaults to process.env.MISTRAL_API_KEY
});
```

See the [repository](https://github.com/livekit/agents-js) for more information
about the framework as a whole.
