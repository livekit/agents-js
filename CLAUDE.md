# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

LiveKit Agents for Node.js — a TypeScript framework for building realtime, multimodal, and voice AI agents that run on servers. This is the Node.js distribution of the [LiveKit Agents framework](https://github.com/livekit/agents) (originally Python).

## Monorepo Structure

- **`agents/`** — Core framework (`@livekit/agents`). Contains agent orchestration, LLM/STT/TTS abstractions, voice pipeline, metrics, IPC/process pooling, and the CLI.
- **`plugins/`** — Provider plugins (`@livekit/agents-plugin-*`). Each implements one or more of: LLM, STT, TTS, VAD, EOU (end-of-utterance), or Avatar.
- **`examples/`** — Example agents (private, not published). Run with `pnpm dlx tsx ./examples/src/<file>.ts dev`.

**Tooling:** pnpm 9.7.0 workspaces, Turborepo for builds, tsup for bundling (CJS + ESM), TypeScript 5.4+, Vitest for tests, Changesets for versioning.

## Common Commands

```bash
pnpm build                  # Build all packages (turbo)
pnpm clean:build            # Clean dist/ dirs then rebuild
pnpm test                   # Run all tests (vitest)
pnpm test -- --testPathPattern=agents/src/llm  # Run tests by path
pnpm test -- --testNamePattern="chat context"  # Run tests by name
pnpm test:watch             # Watch mode
pnpm lint                   # ESLint all packages
pnpm lint:fix               # ESLint with auto-fix
pnpm format:check           # Prettier check
pnpm format:write           # Prettier format
pnpm api:check              # API Extractor validation
pnpm api:update             # Update API declarations
```

### Running an example agent

```bash
pnpm build && pnpm dlx tsx ./examples/src/basic_agent.ts dev --log-level=debug
```

Required env vars: `LIVEKIT_URL`, `LIVEKIT_API_KEY`, `LIVEKIT_API_SECRET`, plus provider keys (e.g. `OPENAI_API_KEY`).

### Debugging individual plugins

Create a test file prefixed with `test_` in `examples/src/`. No `defineAgent` wrapper needed — just import the plugin directly and run:

```bash
pnpm build && node ./examples/src/test_my_plugin.ts
```

## Architecture

Each module under `agents/src/` has its own `CLAUDE.md` with detailed architecture notes. High-level overview:

- **Voice pipeline** (`voice/`): Audio In → VAD → STT → LLM → TTS → Audio Out. `AgentSession` orchestrates, `AgentActivity` manages state machine. `defineAgent({ prewarm, entry })` is the entrypoint pattern.
- **LLM** (`llm/`): `ChatContext` (chronologically ordered), `ChatMessage`, tool calling with Zod schemas, `handoff()` for multi-agent transfers. Provider format adapters for OpenAI and Google.
- **STT** (`stt/`): `SpeechStream` with automatic retry. `StreamAdapter` converts non-streaming STT + VAD to streaming.
- **TTS** (`tts/`): `SynthesizeStream`, `ChunkedStream`. `FallbackAdapter` for multi-provider failover. `StreamAdapter` for non-streaming providers.
- **VAD** (`vad.ts`): Voice Activity Detection interface. Silero plugin is the primary implementation.
- **Inference** (`inference/`): LiveKit Inference Gateway clients. Always use full `provider/model` format (e.g., `'openai/gpt-4o-mini'`).
- **Stream** (`stream/`): Composable Web Streams API primitives (`StreamChannel`, `DeferredStream`, `MultiInputStream`).
- **IPC** (`ipc/`): Process pool for running agents in child processes. Two-way IPC: child sends inference requests back to parent.
- **Worker** (`worker.ts`): Main process connecting to LiveKit server, receives job assignments, spawns agent processes.
- **Plugins** (`livekit-plugins/`): Each extends `Plugin` base class. Pattern: `@livekit/agents-plugin-<provider>`. Exports typed implementations (e.g., `openai.LLM`, `deepgram.STT`).

## Code Conventions

- **License header** required on every new file:
  ```
  // SPDX-FileCopyrightText: 2026 LiveKit, Inc.
  //
  // SPDX-License-Identifier: Apache-2.0
  ```
- **Prettier**: single quotes, trailing commas, 100 char width, sorted imports.
- **ESLint**: `@typescript-eslint` with strict rules. Prefix unused vars with `_`. Use `type` imports (`consistent-type-imports`).
- **TypeScript**: strict mode, `noUncheckedIndexedAccess`, `verbatimModuleSyntax`, target ES2022, module node16.
- **Time units**: Use milliseconds for all time-based values by default. Only use seconds when the name explicitly ends with `InS`.
- **Changesets**: All packages in `agents/` and `plugins/` release together (fixed versioning). Run `pnpm changeset` to add a changeset before PRing. The examples package is ignored.
- **API Extractor**: Public API surface is tracked. Run `pnpm api:check` after changing exports and `pnpm api:update` to update declarations.

## Testing

- **Framework**: Vitest with 5s default timeout.
- **Pattern**: `*.test.ts` files co-located with source.
- **Snapshots**: Used in LLM chat/tool context tests (`agents/src/llm/__snapshots__/`).
- **Inference LLM tests**: Always use full model names from `agents/src/inference/models.ts` (e.g. `'openai/gpt-4o-mini'`, not `'gpt-4o-mini'`). Initialize logger first: `initializeLogger({ pretty: true })`.

## Porting from Python (`livekit-agents`)

When porting features or fixes from the Python `livekit-agents` repo to this JS/TS repo, follow these rules:

### 1. Python reference comments (`// Ref`)

Every JS change that corresponds to a Python change must carry an inline reference comment directly above the relevant line(s):

```ts
// Ref: python <relative-file-path> - <line-range> lines
```

Examples:

```ts
// Ref: python livekit-agents/livekit/agents/voice/agent_session.py - 362-369 lines
private _aecWarmupRemaining = 0;

// Ref: python livekit-agents/livekit/agents/voice/agent_activity.py - 1236-1240 lines
if (this.agentSession._aecWarmupRemaining > 0) { ... }
```

Use the Python file path relative to the repo root. Include the line range from the Python diff so reviewers can cross-reference directly.

### 2. Time unit unification

Python uses **seconds** (`float`) for all time values. JS/TS uses **milliseconds** (`number`) by default.

When porting a Python time parameter:

- Multiply the Python default by `1000` for the JS default (e.g. `3.0 s` → `3000 ms`)
- Use `setTimeout` / `clearTimeout` directly with the ms value — do **not** multiply by `1000` at call sites
- Name the field in plain form (e.g. `aecWarmupDuration`, `userAwayTimeout`) — the ms convention is implied
- Only use seconds as the unit if the variable name explicitly ends with `InS` (e.g. `delayInS`)

Example mapping:

| Python                                            | JS/TS                                      |
| ------------------------------------------------- | ------------------------------------------ |
| `aec_warmup_duration: float = 3.0`                | `aecWarmupDuration: number \| null = 3000` |
| `user_away_timeout: float = 15.0`                 | `userAwayTimeout: number \| null = 15000`  |
| `loop.call_later(self._aec_warmup_remaining, cb)` | `setTimeout(cb, this._aecWarmupRemaining)` |

## CI Requirements

- REUSE/SPDX license compliance
- ESLint passes
- Prettier formatting passes
- Full build succeeds
- Base branch: `main`
