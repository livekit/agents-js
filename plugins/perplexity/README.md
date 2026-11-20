# Perplexity plugin for LiveKit Agents

Support for [Perplexity](https://www.perplexity.ai/) models through the Agent API.

See [https://docs.livekit.io/agents/models/llm/perplexity/](https://docs.livekit.io/agents/models/llm/perplexity/) for more information.

## Installation

```bash
pnpm add @livekit/agents-plugin-perplexity
```

## Pre-requisites

You'll need an API key from Perplexity. It can be passed directly or set as the
`PERPLEXITY_API_KEY` environment variable.

## Usage

```ts
import { responses } from '@livekit/agents-plugin-perplexity';

const llm = new responses.LLM({
  model: 'perplexity/sonar',
  // apiKey is picked up from PERPLEXITY_API_KEY if omitted
});
```

The Responses LLM uses `baseURL: 'https://api.perplexity.ai/v1'`, disables
WebSocket transport, and sends an `X-Pplx-Integration` attribution header on
its OpenAI-compatible client.

## Migrating from Chat Completions

The `LLM` class and `openai.LLM.withPerplexity()` use Sonar Chat Completions and
are deprecated. Replace either legacy path with the Responses LLM:

```ts
import { responses } from '@livekit/agents-plugin-perplexity';

const llm = new responses.LLM({
  model: 'perplexity/sonar',
  // apiKey is picked up from PERPLEXITY_API_KEY if omitted
});
```

See Perplexity's [migration guide](https://docs.perplexity.ai/docs/agent-api/migrate-from-sonar/overview)
for request and model changes when moving from Sonar to the Agent API.
