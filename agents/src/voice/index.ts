// SPDX-FileCopyrightText: 2025 LiveKit, Inc.
//
// SPDX-License-Identifier: Apache-2.0
export {
  Agent,
  AgentTask,
  StopResponse,
  type AgentContext,
  type AgentCreateOptions,
  type AgentHookNodeResult,
  type AgentHooks,
  type AgentOptions,
  type AgentTaskContext,
  type AgentTaskCreateOptions,
  type AgentUpdateOptions,
  type ModelSettings,
} from './agent.js';
export * from './amd.js';
export {
  AgentSession,
  type AgentSessionOptions,
  type AgentSessionUpdateOptions,
  type AgentSessionUsage,
  type ExpressiveOptions,
  type VoiceOptions,
  DEFAULT_EXPRESSIVE_OPTIONS,
  TTS_INSTRUCTIONS_PLACEHOLDER,
  resolveExpressiveOptions,
} from './agent_session.js';
// re-exported here (they are declared alongside the markup tables) so the expressive
// option types all sit together on the session surface, as they do in Python
export type { NonverbalOptions, SpeechSteeringOptions } from '../tts/provider_format.js';
export * from './avatar/index.js';
export * from './background_audio.js';
export { AgentsConsole, TcpAudioInput, TcpAudioOutput } from './console_io.js';
export {
  FinalizeSimulationError,
  type TextInputCallback,
  type TextInputEvent,
  RemoteSession,
  type RemoteSessionCallbacks,
  type RemoteSessionEventTypes,
  SessionHost,
  SessionTransport,
  RoomSessionTransport,
  TcpSessionTransport,
} from './remote_session.js';
export * from './events.js';
export {
  KeytermDetector,
  type KeytermDetectionOptions,
  type KeytermsOptions,
} from './keyterm_detection.js';
export {
  AudioInput,
  AudioOutput,
  type AudioOutputCapabilities,
  type PlaybackFinishedEvent,
  type PlaybackStartedEvent,
  type TimedString,
  createTimedString,
  isTimedString,
} from './io.js';
export * from './report.js';
export * from './room_io/index.js';
export { RunContext } from './run_context.js';
export {
  SpeechHandle,
  SpeechHandleCircularWaitError,
  type InputDetails,
  type ResolvedSpeechHandle,
} from './speech_handle.js';
export * from './turn_config/endpointing.js';
export * from './turn_config/user_turn_limit.js';
export * as testing from './testing/index.js';
export { type RunOutputOptions } from './testing/run_result.js';
export * as textTransforms from './transcription/text_transforms.js';
