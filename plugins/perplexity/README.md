# Perplexity plugin for LiveKit Agents

Support for [Perplexity](https://www.perplexity.ai/) LLMs via the OpenAI-compatible
chat completions endpoint at `https://api.perplexity.ai`.

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
import { LLM } from '@livekit/agents-plugin-perplexity';

const llm = new LLM({
  model: 'sonar-pro',
  // apiKey is picked up from PERPLEXITY_API_KEY if omitted
});
```

The plugin reuses the OpenAI plugin's chat completions transport with
`baseURL: 'https://api.perplexity.ai'` and forwards an `X-Pplx-Integration`
attribution header on every outgoing request.

## Agent API usage

Perplexity's Agent API is compatible with OpenAI's Responses API and is available
through the `responses` submodule.

```ts
import { responses } from '@livekit/agents-plugin-perplexity';

const llm = new responses.LLM({
  model: 'perplexity/sonar',
  // apiKey is picked up from PERPLEXITY_API_KEY if omitted
});
```

The Responses LLM uses `baseURL: 'https://api.perplexity.ai/v1'`, disables
WebSocket transport, and sends the same `X-Pplx-Integration` attribution header
on its OpenAI-compatible client.
