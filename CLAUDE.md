<!--
SPDX-FileCopyrightText: 2026 LiveKit, Inc.

SPDX-License-Identifier: Apache-2.0
-->

# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

LiveKit Agents for Node.js — a TypeScript framework for building realtime, multimodal, and voice AI agents that run on servers. This is the Node.js distribution of the [LiveKit Agents framework](https://github.com/livekit/agents) (originally Python).

## Monorepo Structure

- **`agents/`** — Core framework (`@livekit/agents`). Agent orchestration, LLM/STT/TTS abstractions, voice pipeline, metrics, telemetry, IPC/process pooling, and the CLI.
- **`plugins/`** — Provider plugins (`@livekit/agents-plugin-*`). Each implements one or more of: LLM, STT, TTS, VAD, EOU (end-of-utterance), Realtime, or Avatar.
- **`examples/`** — Example agents (private, not published). Run with `pnpm dlx tsx ./examples/src/<file>.ts dev`.
- **`tests/e2e/`** — End-to-end tests via Docker (separate from unit tests co-located in each package).

**Tooling:** pnpm 9.7.0 workspaces, Turborepo for builds, tsup for bundling (CJS + ESM), TypeScript 5.4+, Vitest for tests, Changesets for versioning.

## Common Commands

```bash
pnpm build                  # Build all packages (turbo)
pnpm build:agents           # Build only @livekit/agents and its deps
pnpm build:plugins          # Build only plugins and their deps
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

### Voice Pipeline (`agents/src/voice/`)

The core of the framework. Pipeline flow: **Audio In → VAD → STT → LLM → TTS → Audio Out**.

Key classes and their roles:

- **`Agent`** — Base class holding instructions, tools, and model config. Subclass to override pipeline hooks (`ttsNode`, `realtimeAudioOutputNode`, `sttNode`, `llmNode`). Use `voice.Agent.default.<hook>(this, ...)` to call the base implementation from overrides.
- **`AgentTask`** — Extends Agent for composable task workflows with isolated chat context and tool scoping.
- **`AgentSession`** — Orchestrates the full session lifecycle: connects to LiveKit room, manages turn detection, handles interruptions, collects metrics. Entry point: `session.start({ agent, room })`.
- **`AgentActivity`** (`agent_activity.ts`, ~100KB) — Complex state machine managing individual turns: VAD trigger → STT → endpointing → LLM inference → TTS generation → playout. Supports preemptive generation (starts LLM while user still speaking).
- **`SpeechHandle`** — Represents a unit of agent speech with lifecycle tracking and priority levels (`LOW=0`, `NORMAL=5`, `HIGH=10`). Sources: `'say'`, `'generate_reply'`, `'tool_response'`.
- **`AvatarSession`** — Base class for avatar plugin sessions. Registers `aclose()` as a job shutdown callback and warns when started after `AgentSession.start()` (which would replace the existing audio output). Plugin implementations extend this class and call `super.start(agentSession, room)` first.

Turn detection modes: `"stt"` | `"vad"` | `"realtime_llm"` | `"manual"` (configured in `turn_config/`).

Interruption detection: `"adaptive"` (ML-based via `inference/interruption/`) or `"vad"` mode.

Subdirectories: `room_io/` (LiveKit Room I/O), `transcription/` (word-level sync), `avatar/` (avatar integration), `recorder_io/` (recording), `testing/` (test utilities), `turn_config/` (turn/interruption/endpointing config).

### LLM (`agents/src/llm/`)

- **`ChatContext`** — Chronologically ordered conversation state. Supports action-aware history summarization via `_summarize(llm, { keepLastTurns })` to compress old messages while preserving tool execution results.
- **Tool system** — `llm.tool()` with Zod schemas for parameters. `handoff()` for multi-agent transfers.
- **`FallbackAdapter`** — Multi-provider LLM failover with availability tracking.
- **Provider format adapters** — `provider_format/openai.ts`, `provider_format/google.ts`, and `provider_format/mistralai.ts` for model-agnostic code.

### Other Core Modules

- **STT** (`stt/`): `SpeechStream` with automatic retry. `StreamAdapter` converts non-streaming STT + VAD to streaming.
- **TTS** (`tts/`): `SynthesizeStream`, `ChunkedStream`. `FallbackAdapter` for multi-provider failover. `StreamAdapter` for non-streaming providers.
- **VAD** (`vad.ts`): Voice Activity Detection interface. Silero plugin is the primary implementation.
- **Inference** (`inference/`): LiveKit Inference Gateway clients (LLM, STT, TTS). Always use full `provider/model` format (e.g., `'openai/gpt-4o-mini'`). Also includes `interruption/` for adaptive interruption detection via ML models.
- **Stream** (`stream/`): Composable Web Streams API primitives (`StreamChannel`, `DeferredStream`, `MultiInputStream`).
- **IPC** (`ipc/`): Process pool for running agents in child processes. Two-way IPC: child sends inference requests back to parent.
- **Worker** (`worker.ts`): Main process connecting to LiveKit server, receives job assignments, spawns agent processes.
- **Telemetry** (`telemetry/`): OpenTelemetry tracing with custom span attributes (TTFT, TTFB, interruption probability, speech IDs, provider request IDs). Pino transport for structured logging.
- **Metrics** (`metrics/`): `AgentMetrics` union type covering LLM, STT, TTS, VAD, EOU, Realtime, and Interruption metrics. `ModelUsageCollector` for aggregating per-provider usage.
- **Beta** (`beta/`): `TaskGroup` for multi-task orchestration with optional chat context summarization between tasks.

### Remote Sessions (`voice/remote_session.ts`)

Wire protocol for distributed agents via LiveKit room message channels. `SessionTransport` abstraction with `RoomSessionTransport` implementation.

### Plugins (`plugins/`)

Each extends `Plugin` base class, auto-registers on import via `Plugin.registerPlugin()`. Pattern: `@livekit/agents-plugin-<provider>`.

Plugin capabilities by type:

- **LLM**: openai, google, baseten, mistralai
- **STT**: deepgram (v1+v2), openai, baseten, sarvam (v1/v2/v3), mistralai
- **TTS**: cartesia, elevenlabs, deepgram, openai, neuphonic, resemble, rime, inworld, baseten, sarvam (v1/v2/v3), mistralai
- **VAD**: silero (ONNX-based, local)
- **EOU/Turn Detection**: livekit (HuggingFace + ONNX)
- **Realtime**: openai (+ responses/, ws/ modules), google (beta), xai, phonic
- **Avatar**: hedra, trugen, lemonslice, bey, anam, liveavatar
- **Test mocks**: test (private, for unit tests)

### AsyncLocalStorage Patterns

The framework uses Node.js `AsyncLocalStorage` for implicit context passing:

- `agentActivityStorage` — Access current `AgentActivity` in callbacks
- `functionCallStorage` — Access current `FunctionCall` in tool handlers
- `speechHandleStorage` — Access current `SpeechHandle`

## Code Conventions

- **License header** required on every new file:
  ```
  // SPDX-FileCopyrightText: 2026 LiveKit, Inc.
  //
  // SPDX-License-Identifier: Apache-2.0
  ```
- **Prettier**: single quotes, trailing commas, 100 char width, sorted imports (`@trivago/prettier-plugin-sort-imports`).
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
- **Test plugin**: `@livekit/agents-plugins-test` provides mock LLM, STT, TTS for unit tests without external APIs.
- **PR validation for major changes**: Verify `restaurant_agent.ts` and `realtime_agent.ts` work properly in [Agent Playground](https://agents-playground.livekit.io).

## Porting from Python (`livekit-agents`)

When porting features or fixes from the Python `livekit-agents` repo to this JS/TS repo, follow these rules:

### Time unit unification

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
