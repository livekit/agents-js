// SPDX-FileCopyrightText: 2024 LiveKit, Inc.
//
// SPDX-License-Identifier: Apache-2.0
export {
  CONFIRM_DUPLICATE_PARAM,
  handoff,
  isFunctionTool,
  isProviderTool,
  isTool,
  isToolset,
  ProviderTool,
  sortedToolEntries,
  sortedToolNames,
  tool,
  ToolContext,
  ToolError,
  ToolFlag,
  Toolset,
  toToolContext,
  type AgentHandoff,
  type DuplicateMode,
  type FunctionTool,
  type Tool,
  type ToolCalledEvent,
  type ToolChoice,
  type ToolCompletedEvent,
  type ToolContextEntry,
  type ToolContextLike,
  type ToolOptions,
  type ToolsetContext,
  type ToolsetCreateOptions,
  type ToolType,
} from './tool_context.js';

export { AsyncToolset, type AsyncToolsetCreateOptions } from './async_toolset.js';
export type {
  AsyncToolOptions,
  DuplicatePromptArgs,
  ReplyPromptArgs,
  ToolHandlingOptions,
} from '../voice/tool_executor.js';

export {
  AgentHandoffItem,
  AgentConfigUpdate,
  ChatContext,
  ChatMessage,
  Instructions,
  createAudioContent,
  createImageContent,
  FunctionCall,
  FunctionCallOutput,
  type AudioContent,
  type ChatContent,
  type ChatItem,
  type ChatRole,
  type ImageContent,
  type MetricsReport,
} from './chat_context.js';

export type { ProviderFormat } from './provider_format/index.js';

export {
  LLM,
  LLMStream,
  type ChatChunk,
  type ChoiceDelta,
  type CollectedResponse,
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
  formatChatHistory,
  oaiBuildFunctionInfo,
  oaiParams,
  serializeImage,
  toJsonSchema,
  validateChatContextStructure,
  type ChatContextValidationIssue,
  type ChatContextValidationResult,
  type ChatContextValidationSeverity,
  type FormatChatHistoryOptions,
  type OpenAIFunctionParameters,
  type SerializedImage,
} from './utils.js';

export {
  FallbackAdapter,
  type AvailabilityChangedEvent,
  type FallbackAdapterOptions,
} from './fallback_adapter.js';
