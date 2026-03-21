# CLAUDE.md

This file provides guidance to [Claude Code](https://claude.com/claude-code) 
when working with code in this repository.

## Overview

**livekit/agents-js** is a monorepo for building realtime, multimodal AI agents in Node.js.
It is the Node.js distribution of the [LiveKit Agents framework](https://livekit.io/agents),
originally written in Python.

## Repository Structure

```
agents-js/
├── agents/               # Core agent framework
│   └── src/
│       ├── worker.ts     # Main Worker class
│       ├── job.ts       # Job management
│       ├── vad.ts       # Voice Activity Detection
│       ├── stt/         # Speech-to-Text plugins
│       ├── tts/         # Text-to-Speech plugins
│       ├── llm/         # LLM integrations
│       └── inference/   # Inference runner
├── plugins/             # Plugin ecosystem (openai, deepgram, elevenlabs, etc.)
├── examples/           # Usage examples
├── tests/              # Test suite
└── scripts/            # Build and CI scripts
```

## Tech Stack

- **Runtime:** Node.js (TypeScript)
- **Package Manager:** pnpm (monorepo with workspaces)
- **Build:** tsup
- **Testing:** vitest
- **Linting:** ESLint + Prettier
- **API docs:** TypeDoc

## Key Commands

```bash
# Install dependencies
pnpm install

# Build all packages
pnpm -w build

# Type-check
pnpm -w lint

# Run tests
pnpm -w test

# Format code
pnpm -w format:write

# Lint with auto-fix
pnpm -w lint:fix
```

## Code Style

- **Formatting:** Prettier (run `pnpm -w format:write` before committing)
- **Linting:** ESLint with auto-fix (`pnpm -w lint:fix`)
- **Headers:** All new files must include [REUSE-3.2](https://reuse.software) SPDX headers:

```typescript
// SPDX-FileCopyrightText: 2024 LiveKit, Inc.
// SPDX-License-Identifier: Apache-2.0
```

- **Documentation:** All new methods/interfaces/classes must be documented with TypeDoc comments
- **Branch:** Always base work off `main` branch

## Architecture Notes

### Worker Model
Agents run as `Worker` processes managed by the framework. Jobs are dispatched to workers
which run `Agent` instances that process media streams.

### IPC
The framework uses Node.js IPC for communication between the main process and worker processes.
When the IPC channel closes during inference, use `safeSend()` gracefully — do NOT throw.
See [#1080](https://github.com/livekit/agents-js/issues/1080) for context.

### Plugins
Plugins follow a consistent interface for STT, TTS, and LLM providers. When adding a new plugin,
mirror the structure of existing plugins (e.g., `@livekit/agents-plugin-deepgram`).

### Monorepo
This is a pnpm monorepo. Always run commands with `pnpm -w` (workspace root) to ensure all
packages are built/tested consistently.

## Common Issues

- **IPC channel closed errors:** Don't throw in `safeSend` — return false and handle gracefully
- **API extractor failures:** Run `pnpm -w api:update` if API surface types change
- **Test failures on CI:** Ensure both `restaurant_agent.ts` and `realtime_agent.ts` examples work

## Issue Guidelines

- For bugs, include: Node.js version, platform, plugin versions, and minimal reproduction steps
- For features, open an issue first to discuss viability before starting work
- For voice/STT issues, specify which plugin and model is being used
