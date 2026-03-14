# CLAUDE.md

Inter-process communication for running agents in child Node.js processes.

## Key Classes

- **ProcPool** — Manages warm process pool. Pre-spawns processes and queues them for reuse. Uses `MultiMutex` to control warm process count.
- **SupervisedProc** — Base class for child process lifecycle: health monitoring (ping/pong), memory limits (warns at threshold, kills at limit), graceful shutdown.
- **JobProcExecutor** — Extends SupervisedProc. Forks child process for job execution. Handles inference requests from child by delegating to parent's `InferenceExecutor`.
- **InferenceExecutor** — Interface with single `doInference(method, data)` method. Runs in parent process to share GPU/model resources.

## IPC Protocol

Strongly-typed message union in `message.ts`: `initializeRequest/Response`, `pingRequest/pongResponse`, `startJobRequest`, `shutdownRequest`, `inferenceRequest/Response`, `exiting`, `done`.

## Non-Obvious Patterns

- **Two-way IPC**: Child sends inference requests → parent executes with shared models → parent sends results back. This avoids loading models in every child process.
- **TypeScript child process**: `createProcess()` detects TS files and passes appropriate `execArgv` so the TS loader works in the child.
- **Future-based sync**: `init` and `join` Futures prevent race conditions during process startup and shutdown.
- **Graceful shutdown**: Sends `shutdownRequest`, waits up to `closeTimeout`, then forceful `kill()`.
- **Only `InferenceExecutor` is publicly exported** — the rest is internal.
