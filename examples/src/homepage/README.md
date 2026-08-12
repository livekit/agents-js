# Homepage knowledge agent

A voice agent that answers questions about LiveKit products. Knowledge about the
Agents SDKs stays in the system prompt for low-latency answers, while other product
knowledge is loaded on demand through a generated `lookup_product` tool.

## Architecture

- `agent.ts` is the composition root. It contains the immutable `AgentConfig`,
  `Assistant`, session setup, and server entrypoint.
- `knowledge_base/` discovers one Markdown file per product and derives both the
  tool schema and lookup results from those files.
- `prompts/` contains all authored agent language as Markdown templates.
- `behaviors/` contains session event behavior and frontend integration.
- `filters/` contains streaming voice-pipeline transformations.
- `tests/unit/` is deterministic; `tests/evals/` runs live behavioral evaluations.

The voice pipeline uses LiveKit Inference with Gemma 4 31B, Deepgram Nova-3,
Fish Audio S2.1 Pro in expressive mode, the LiveKit turn detector, and Krisp
voice isolation.

## Run locally

From the repository root, install dependencies and provide LiveKit Cloud credentials
in `.env` or the environment:

```bash
pnpm install
pnpm build
node --env-file-if-exists=.env examples/dist/homepage/agent.js console
```

Use `dev` instead of `console` to connect the agent to LiveKit Cloud for a frontend
or telephony session.

## Tests and evals

Run the fast unit suite:

```bash
pnpm exec vitest run examples/src/homepage/tests/unit
```

Run the live LLM-backed eval suite with:

```bash
pnpm --filter livekit-agents-examples test:evals
```

The evals require `LIVEKIT_API_KEY` and `LIVEKIT_API_SECRET` and cover tool routing,
grounded facts, anti-hallucination behavior, inline knowledge, and multi-turn grounding.

Build the production image from the repository root so the monorepo workspace is
available as its build context:

```bash
docker build -f examples/src/homepage/Dockerfile .
```
