// SPDX-FileCopyrightText: 2024 LiveKit, Inc.
//
// SPDX-License-Identifier: Apache-2.0
import type { JSONSchema7 } from 'json-schema';
import { z } from 'zod';
import type { Agent } from '../voice/agent.js';
import type { RunContext, UnknownUserData } from '../voice/run_context.js';
import { isZodObjectSchema, isZodSchema } from './zod-utils.js';

// heavily inspired by Vercel AI's `tool()`:
// https://github.com/vercel/ai/blob/3b0983b/packages/ai/core/tool/tool.ts

const TOOL_SYMBOL = Symbol('tool');
const FUNCTION_TOOL_SYMBOL = Symbol('function_tool');
const PROVIDER_DEFINED_TOOL_SYMBOL = Symbol('provider_defined_tool');
const TOOL_ERROR_SYMBOL = Symbol('tool_error');
const HANDOFF_SYMBOL = Symbol('handoff');

export type JSONValue = null | string | number | boolean | JSONObject | JSONArray;

export type JSONArray = JSONValue[];

export type JSONObject = {
  [key: string]: JSONValue;
};

// Supports both Zod v3 and v4 schemas, as well as raw JSON schema
// Adapted from Vercel AI SDK's FlexibleSchema approach
// Source: https://github.com/vercel/ai/blob/main/packages/provider-utils/src/schema.ts#L67-L70
//
// Vercel uses StandardSchemaV1 from @standard-schema/spec package.
// We use a simpler approach by directly checking for schema properties:
// - Zod v3: Has `_output` property
// - Zod v4: Implements Standard Schema spec with `~standard` property
// - JSON Schema: Plain object fallback
export type ToolInputSchema<T = JSONObject> =
  | {
      // Zod v3 schema - has _output property for type inference
      _output: T;
    }
  | {
      // Zod v4 schema (Standard Schema) - has ~standard property
      '~standard': {
        types?: { output: T };
      };
    }
  | JSONSchema7;

/**
 * Infer the output type from a ToolInputSchema.
 * Adapted from Vercel AI SDK's InferSchema type.
 * Source: https://github.com/vercel/ai/blob/main/packages/provider-utils/src/schema.ts#L72-L79
 */
export type InferToolInput<T> = T extends { _output: infer O }
  ? O
  : T extends { '~standard': { types?: { output: infer O } } }
    ? O
    : any; // eslint-disable-line @typescript-eslint/no-explicit-any -- Fallback type for JSON Schema objects without type inference

export type ToolType = 'function' | 'provider-defined';

export type ToolChoice =
  | 'auto'
  | 'none'
  | 'required'
  | {
      type: 'function';
      function: {
        name: string;
      };
    };

export class ToolError extends Error {
  constructor(message: string) {
    super(message);

    Object.defineProperty(this, TOOL_ERROR_SYMBOL, {
      value: true,
    });
  }
}

export interface AgentHandoff {
  /**
   * The agent to handoff to.
   */
  agent: Agent;

  /**
   * The return value of the tool.
   */
  returns?: any; // eslint-disable-line @typescript-eslint/no-explicit-any

  [HANDOFF_SYMBOL]: true;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function handoff(options: { agent: Agent; returns?: any }): AgentHandoff {
  return {
    agent: options.agent,
    returns: options.returns,
    [HANDOFF_SYMBOL]: true,
  };
}

export interface ToolOptions<UserData = UnknownUserData> {
  /**
   * RunContext for the current agent session.
   */
  ctx: RunContext<UserData>;

  /**
   * The ID of the tool call.
   */
  toolCallId: string;

  /**
   * An optional abort signal that indicates that the overall operation should be aborted.
   */
  abortSignal?: AbortSignal;
}

export type ToolExecuteFunction<
  Parameters extends JSONObject,
  UserData = UnknownUserData,
  Result = unknown,
> = (args: Parameters, opts: ToolOptions<UserData>) => Promise<Result>;

export interface Tool {
  /**
   * The type of the tool.
   * @internal Either user-defined core tool or provider-defined tool.
   */
  type: ToolType;

  [TOOL_SYMBOL]: true;
}

// TODO(AJS-112): support provider-defined tools
export interface ProviderDefinedTool extends Tool {
  type: 'provider-defined';

  /**
   * The ID of the tool.
   */
  id: string;

  /**
   * The configuration of the tool.
   */
  config: Record<string, unknown>;

  [PROVIDER_DEFINED_TOOL_SYMBOL]: true;
}

export interface FunctionTool<
  Parameters extends JSONObject,
  UserData = UnknownUserData,
  Result = unknown,
> extends Tool {
  type: 'function';

  /**
   * The description of the tool. Will be used by the language model to decide whether to use the tool.
   */
  description: string;

  /**
   * The schema of the input that the tool expects. The language model will use this to generate the input.
   * It is also used to validate the output of the language model.
   * Use descriptions to make the input understandable for the language model.
   */
  parameters: ToolInputSchema<Parameters>;

  /**
   * An async function that is called with the arguments from the tool call and produces a result.
   * It also carries context about current session, user-defined data, and the tool call id, etc.
   */
  execute: ToolExecuteFunction<Parameters, UserData, Result>;

  [FUNCTION_TOOL_SYMBOL]: true;
}

// TODO(AJS-112): support provider-defined tools in the future)
export type ToolContext<UserData = UnknownUserData> = {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- Generic tool registry needs to accept any parameter/result types
  [name: string]: FunctionTool<any, UserData, any>;
};

export function isSameToolContext(ctx1: ToolContext, ctx2: ToolContext): boolean {
  const toolNames = new Set(Object.keys(ctx1));
  const toolNames2 = new Set(Object.keys(ctx2));

  if (toolNames.size !== toolNames2.size) {
    return false;
  }

  for (const name of toolNames) {
    if (!toolNames2.has(name)) {
      return false;
    }

    const tool1 = ctx1[name];
    const tool2 = ctx2[name];

    if (!tool1 || !tool2) {
      return false;
    }

    if (tool1.description !== tool2.description) {
      return false;
    }
  }

  return true;
}

export function isSameToolChoice(choice1: ToolChoice | null, choice2: ToolChoice | null): boolean {
  if (choice1 === choice2) {
    return true;
  }
  if (choice1 === null || choice2 === null) {
    return false;
  }
  if (typeof choice1 === 'string' && typeof choice2 === 'string') {
    return choice1 === choice2;
  }
  if (typeof choice1 === 'object' && typeof choice2 === 'object') {
    return choice1.type === choice2.type && choice1.function.name === choice2.function.name;
  }
  return false;
}

/**
 * Create a function tool with inferred parameters from the schema.
 */
export function tool<
  Schema extends ToolInputSchema<any>, // eslint-disable-line @typescript-eslint/no-explicit-any -- Generic constraint needs to accept any JSONObject type
  UserData = UnknownUserData,
  Result = unknown,
>({
  description,
  parameters,
  execute,
}: {
  description: string;
  parameters: Schema;
  execute: ToolExecuteFunction<InferToolInput<Schema>, UserData, Result>;
}): FunctionTool<InferToolInput<Schema>, UserData, Result>;

/**
 * Create a function tool without parameters.
 */
export function tool<UserData = UnknownUserData, Result = unknown>({
  description,
  execute,
}: {
  description: string;
  parameters?: never;
  execute: ToolExecuteFunction<Record<string, never>, UserData, Result>;
}): FunctionTool<Record<string, never>, UserData, Result>;

/**
 * Create a provider-defined tool.
 *
 * @param id - The ID of the tool.
 * @param config - The configuration of the tool.
 */
export function tool({
  id,
  config,
}: {
  id: string;
  config: Record<string, unknown>;
}): ProviderDefinedTool;

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function tool(tool: any): any {
  if (tool.execute !== undefined) {
    // Default parameters to z.object({}) if not provided
    const parameters = tool.parameters ?? z.object({});

    // if parameters is a Zod schema, ensure it's an object schema
    if (isZodSchema(parameters) && !isZodObjectSchema(parameters)) {
      throw new Error('Tool parameters must be a Zod object schema (z.object(...))');
    }

    // Ensure parameters is either a Zod schema or a plain object (JSON schema)
    if (!isZodSchema(parameters) && !(typeof parameters === 'object')) {
      throw new Error('Tool parameters must be a Zod object schema or a raw JSON schema');
    }

    return {
      type: 'function',
      description: tool.description,
      parameters,
      execute: tool.execute,
      [TOOL_SYMBOL]: true,
      [FUNCTION_TOOL_SYMBOL]: true,
    };
  }

  if (tool.config !== undefined && tool.id !== undefined) {
    return {
      type: 'provider-defined',
      id: tool.id,
      config: tool.config,
      [TOOL_SYMBOL]: true,
      [PROVIDER_DEFINED_TOOL_SYMBOL]: true,
    };
  }

  throw new Error('Invalid tool');
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function isTool(tool: any): tool is Tool {
  return tool && tool[TOOL_SYMBOL] === true;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function isFunctionTool(tool: any): tool is FunctionTool<any, any, any> {
  const isTool = tool && tool[TOOL_SYMBOL] === true;
  const isFunctionTool = tool[FUNCTION_TOOL_SYMBOL] === true;
  return isTool && isFunctionTool;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function isProviderDefinedTool(tool: any): tool is ProviderDefinedTool {
  const isTool = tool && tool[TOOL_SYMBOL] === true;
  const isProviderDefinedTool = tool[PROVIDER_DEFINED_TOOL_SYMBOL] === true;
  return isTool && isProviderDefinedTool;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function isToolError(error: any): error is ToolError {
  return error && error[TOOL_ERROR_SYMBOL] === true;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function isAgentHandoff(handoff: any): handoff is AgentHandoff {
  return handoff && handoff[HANDOFF_SYMBOL] === true;
}
