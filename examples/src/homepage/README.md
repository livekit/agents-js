<!--
SPDX-FileCopyrightText: 2026 LiveKit, Inc.

SPDX-License-Identifier: Apache-2.0
-->

# Homepage knowledge agent

A voice agent that answers questions about LiveKit products. Knowledge about the Agents SDKs stays in the system prompt for low-latency answers, while other product knowledge is loaded on demand through a generated `lookup_product` tool.

## Architecture

- `agent.ts` is the composition root. It contains the immutable `AgentConfig`, `Assistant`, session setup, and server entrypoint.
- `knowledge_base/` discovers one Markdown file per product and derives both the tool schema and lookup results from those files.
- `prompts/` contains all authored agent language as Markdown templates.
- `behaviors/` contains session event behavior and frontend integration.
- `filters/` contains streaming voice-pipeline transformations.
- `*.test.ts` files are deterministic unit tests; `homepage_agent.evals.test.ts` runs live behavioral evaluations when `LIVEKIT_RUN_HOMEPAGE_EVALS=1` is set.

The voice pipeline uses LiveKit Inference with Gemma 4 31B, Deepgram Nova-3, Inworld TTS, the LiveKit turn detector, and background voice cancellation.

## Run locally

From the repository root, install dependencies, build, and provide LiveKit Cloud credentials in the environment:

```bash
pnpm install
pnpm build
node ./examples/src/homepage/agent.ts dev
```

Use `dev` to connect the agent to LiveKit Cloud for a frontend or telephony session.

## Tests and evals

Run the fast unit suite:

```bash
pnpm --filter livekit-agents-examples test -- examples/src/homepage
```

Run the live LLM-backed eval suite with:

```bash
LIVEKIT_RUN_HOMEPAGE_EVALS=1 pnpm --filter livekit-agents-examples test -- examples/src/homepage/homepage_agent.evals.test.ts
```

The evals require `LIVEKIT_API_KEY` and `LIVEKIT_API_SECRET` and cover tool routing, grounded facts, anti-hallucination behavior, inline knowledge, and multi-turn grounding.
