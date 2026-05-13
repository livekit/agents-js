# Perplexity plugin for LiveKit Node Agents

Support for [Perplexity](https://www.perplexity.ai/) LLMs via the OpenAI-compatible
chat completions endpoint at `https://api.perplexity.ai`.

## Installation

```bash
pnpm add @livekit/agents-plugin-perplexity
```

## Pre-requisites

You'll need an API key from Perplexity. It can be passed directly or set as the
`PERPLEXITY_API_KEY` environment variable.

## Usage

```ts
import * as perplexity from '@livekit/agents-plugin-perplexity';

const llm = new perplexity.LLM({
  model: 'sonar-pro',
  // apiKey picked up from PERPLEXITY_API_KEY if omitted
});
```

The plugin reuses the OpenAI plugin's chat completions transport with
`baseURL: 'https://api.perplexity.ai'` and forwards an `X-Pplx-Integration`
attribution header on every outgoing request.
