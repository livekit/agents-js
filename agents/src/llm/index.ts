// SPDX-FileCopyrightText: 2024 LiveKit, Inc.
//
// SPDX-License-Identifier: Apache-2.0
// export {
//   oaiBuildFunctionInfo,
//   oaiParams,
//   type CallableFunction,
//   type CallableFunctionResult,
//   type FunctionCallInfo,
//   type FunctionContext,
//   type inferParameters,
// } from './function_context.js';

export {
  tool,
  type FunctionTool,
  type ProviderDefinedTool,
  type Tool,
  type ToolContext,
  type ToolExecutionOptions,
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
  type Choice,
  type ChoiceDelta,
  type CompletionUsage,
  type LLMCallbacks,
} from './llm.js';

export {
  createToolOptions,
  executeToolCall,
  oaiBuildFunctionInfo,
  oaiParams,
  type OpenAIFunctionParameters,
} from './utils.js';
