// SPDX-FileCopyrightText: 2024 LiveKit, Inc.
//
// SPDX-License-Identifier: Apache-2.0
export {
  handoff,
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
  ChatContext,
  ChatMessage,
  FunctionCall,
  FunctionCallOutput,
  type AudioContent,
  type ChatContent,
  type ChatItem,
  type ChatRole,
  type ImageContent,
} from './chat_context.js';

export {
  LLM,
  LLMEvent,
  LLMStream,
  type ChatChunk,
  type ChoiceDelta,
  type CompletionUsage,
  type LLMCallbacks,
} from './llm.js';

export {
  RealtimeModel,
  RealtimeSession,
  type RealtimeCapabilities,
  type InputSpeechStartedEvent,
  type InputSpeechStoppedEvent,
  type MessageGeneration,
  type GenerationCreatedEvent,
  type InputTranscriptionCompleted,
} from './realtime.js';

export { RemoteChatContext } from './remote_chat_context.js';

export {
  createToolOptions,
  executeToolCall,
  oaiBuildFunctionInfo,
  oaiParams,
  type OpenAIFunctionParameters,
} from './utils.js';
