# LiveKit Agents Examples

> **Looking for examples and guides?** Most examples now live in the [LiveKit docs](https://docs.livekit.io/agents/). Browse the full collection of runnable examples and recipes on the [Recipes page](https://docs.livekit.io/reference/recipes).

This directory contains various examples demonstrating different capabilities and use cases for LiveKit agents. Each example showcases specific features, integrations, or workflows that can be built with the LiveKit Agents framework.

## Model Configuration

Most examples use **LiveKit Inference** by default for STT, LLM, and TTS models. This provides a unified API for accessing multiple model providers through LiveKit Cloud.

```typescript
import { AgentSession, inference } from '@livekit/agents';

const session = new AgentSession({
  stt: new inference.STT({ model: 'deepgram/nova-3' }),
  llm: new inference.LLM({ model: 'google/gemma-4-31b-it' }),
  tts: new inference.TTS({ model: 'cartesia/sonic-3' }),
});
```

**Note:** Realtime models are not supported by LiveKit Inference and must use the
provider plugin directly.

## Example Categories

### [Homepage](./src/homepage/)

A product knowledge agent demonstrating progressive disclosure with a Markdown-backed
knowledge base, generated tool schemas, centralized prompt templates, session behaviors,
streaming TTS filters, and a split unit/eval test suite.

### [Drive-Thru](./src/drive-thru/)

A complete drive-thru ordering system with database integration and order management.

### [Front Desk](./src/frontdesk/)

A customer-service agent with calendar integration and appointment management.

Other standalone examples are located directly in [`src/`](./src/).

## Running Examples

From the repository root, install dependencies and build the monorepo:

```bash
pnpm install
pnpm build
```

Run an individual built example with the Agents CLI, for example:

```bash
node examples/dist/homepage/agent.js console
```

Provide `LIVEKIT_URL`, `LIVEKIT_API_KEY`, and `LIVEKIT_API_SECRET` in the environment
when connecting to LiveKit Cloud. Provider-specific examples may require additional keys.

## Additional Resources

- [LiveKit Documentation](https://docs.livekit.io/)
- [LiveKit Agents Documentation](https://docs.livekit.io/agents/)
