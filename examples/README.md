<!--
SPDX-FileCopyrightText: 2026 LiveKit, Inc.

SPDX-License-Identifier: Apache-2.0
-->

# LiveKit Agents JS Examples

This directory contains examples demonstrating different capabilities and use cases for LiveKit Agents JS.

## Model Configuration

Most examples use LiveKit Inference by default for STT, LLM, and TTS models. This provides a unified API for accessing multiple model providers through LiveKit Cloud.

```ts
import { AgentSession, inference } from '@livekit/agents';

const session = new AgentSession({
  stt: new inference.STT({ model: 'deepgram/nova-3' }),
  llm: new inference.LLM({ model: 'openai/gpt-4.1-mini' }),
  tts: new inference.TTS({ model: 'cartesia/sonic-3' }),
});
```

## Example Categories

### [Homepage](./src/homepage/)

A product knowledge agent demonstrating progressive disclosure with a Markdown-backed knowledge base, generated tool schemas, centralized prompt templates, session behaviors, streaming TTS filters, and a split unit/eval test suite.

### Voice Agents

Voice-based agent examples, including basic voice interactions, tool integrations, realtime models, and multi-agent workflows.

### Avatar Agents

Examples showing how to integrate visual avatars with voice agents using avatar providers.

### [Drive-Thru](./src/drive-thru/)

A complete drive-thru ordering system example that showcases interactive voice agents for food ordering with database integration and order management.

### [Front Desk](./src/frontdesk/)

A front desk agent example demonstrating customer service agents with calendar integration and appointment management.

## Running Examples

To run the examples, you'll need:

- A LiveKit Cloud account or local LiveKit server.
- API keys for the model providers you want to use.
- Node.js and pnpm.

From the repository root, install dependencies and build:

```bash
pnpm install
pnpm build
```

Run an example agent:

```bash
node ./examples/src/basic_agent.ts dev
```
