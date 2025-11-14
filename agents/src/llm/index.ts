// SPDX-FileCopyrightText: 2024 LiveKit, Inc.
//
// SPDX-License-Identifier: Apache-2.0
export {
  handoff,
  isFunctionTool,
  tool,
  ToolError,
  type AgentHandoff,
  type FunctionTool,
  type ProviderDefinedTool,
  type Tool,
  type ToolChoice,
  type ToolContext,
  type ToolOptions,
  type ToolType,
} from './tool_context.js';

export {
  AgentHandoffItem,
  ChatContext,
  ChatMessage,
  createAudioContent,
  createImageContent,
  FunctionCall,
  FunctionCallOutput,
  type AudioContent,
  type ChatContent,
  type ChatItem,
  type ChatRole,
  type ImageContent,
} from './chat_context.js';

export type { ProviderFormat } from './provider_format/index.js';

export {
  LLM,
  LLMStream,
  type ChatChunk,
  type ChoiceDelta,
  type CompletionUsage,
  type LLMCallbacks,
} from './llm.js';

export {
  RealtimeModel,
  RealtimeSession,
  type GenerationCreatedEvent,
  type InputSpeechStartedEvent,
  type InputSpeechStoppedEvent,
  type InputTranscriptionCompleted,
  type MessageGeneration,
  type RealtimeCapabilities,
  type RealtimeModelError,
  type RealtimeSessionReconnectedEvent,
} from './realtime.js';

export { RemoteChatContext } from './remote_chat_context.js';

export {
  computeChatCtxDiff,
  createToolOptions,
  executeToolCall,
  oaiBuildFunctionInfo,
  oaiParams,
  toJsonSchema,
  type OpenAIFunctionParameters,
} from './utils.js';
