# CLAUDE.md

Core voice agent pipeline: Audio In → VAD → STT → LLM → TTS → Audio Out.

## Key Classes

- **Agent** — Defines agent behavior (instructions, tools, model config). Override hooks (`sttNode`, `llmNode`, `ttsNode`, `realtimeAudioOutputNode`) to customize pipeline stages.
- **AgentSession** — Top-level container that wires VAD, STT, LLM, TTS together. Call `session.start({ agent, room })`.
- **AgentActivity** — Internal state machine. Runs a `mainTask()` loop with a priority-based speech queue (Heap). Manages turn-taking, interruptions, and agent transitions.
- **AgentTask** — For multi-agent scenarios. Can only be called from tool execution or `onEnter()`/`onExit()` hooks.
- **SpeechHandle** — Per-utterance lifecycle handle for controlling playback and interruptions.

## Data Flow

1. Audio → `AgentInput` (pluggable) → `AudioRecognition` (VAD/STT) → turn boundary detected
2. `AgentActivity.mainTask()` picks from speech queue → `agent.llmNode()` → tool calls if any → `agent.ttsNode()`
3. TTS audio → `AgentOutput` (pluggable) → room or custom sink

## Non-Obvious Patterns

- **AsyncLocalStorage contexts**: `agentActivityStorage`, `functionCallStorage`, `speechHandleStorage` carry context through async boundaries into tool functions — no need to pass session/context through function signatures.
- **AEC warmup**: First 3000ms of agent speech suppresses interruption detection to let echo cancellation settle. Early user interruptions are silently dropped.
- **Turn detection priority**: RealtimeModel → VAD → STT → manual. Incompatible user-specified modes are silently overridden (check logs).
- **Agent handoff**: Pauses speech scheduling → waits for in-flight playout → runs `onExit()` → merges chat context (excludes function calls and instructions) → runs new agent's `onEnter()` → resumes scheduling.
- **Preemptive generation**: When enabled, speculatively runs LLM/TTS before end-of-turn is confirmed. Cancelled and restarted if user continues speaking.
- **Error self-healing**: Error counts per type (LLM, TTS, interruption) reset when agent successfully speaks. After `maxUnrecoverableErrors`, session closes.
- **User away state**: Timer starts when both agent and user are in 'listening' state. After `userAwayTimeout` (default 15s), user state → 'away'.

## Subdirectories

- `room_io/` — LiveKit room audio/text input/output adapters
- `recorder_io/` — Session recording
- `transcription/` — Transcript synchronization with audio playback
- `turn_config/` — Turn detection, endpointing, interruption configuration
- `avatar/` — Avatar/video streaming support

