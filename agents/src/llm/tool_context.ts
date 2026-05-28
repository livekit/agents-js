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

export const ToolFlag = {
  NONE: 0,
  IGNORE_ON_ENTER: 1 << 0,
} as const;

export type ToolFlag = (typeof ToolFlag)[keyof typeof ToolFlag];

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
   * The name of the tool. Used to identify it inside a `ToolContext` and exposed to the LLM
   * as the function name to call.
   */
  name: string;

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

  flags: number;

  [FUNCTION_TOOL_SYMBOL]: true;
}

/**
 * Convenience input shape accepted by APIs that want to take a list of tools directly without
 * forcing callers to wrap them in `new ToolContext(...)`.
 */
export type ToolCtxInput<UserData = UnknownUserData> =
  | ToolContext<UserData>
  | readonly ToolContextEntry<UserData>[];

export function toToolContext<UserData = UnknownUserData>(
  input: ToolCtxInput<UserData>,
): ToolContext<UserData>;
export function toToolContext<UserData = UnknownUserData>(
  input: ToolCtxInput<UserData> | undefined,
): ToolContext<UserData> | undefined;
export function toToolContext<UserData = UnknownUserData>(
  input: ToolCtxInput<UserData> | undefined,
): ToolContext<UserData> | undefined {
  if (input === undefined) return undefined;
  return input instanceof ToolContext ? input : new ToolContext(input);
}

//TODO: toolset - accept stateful `Toolset` containers alongside `FunctionTool` /
// eslint-disable-next-line @typescript-eslint/no-explicit-any -- ToolContext entries accept any function-tool parameter/result types
export type ToolContextEntry<UserData = UnknownUserData> =
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  FunctionTool<any, UserData, any> | ProviderDefinedTool;

export class ToolContext<UserData = UnknownUserData> {
  // TODO: toolset - widen entries to `FunctionTool | ProviderDefinedTool | Toolset` once Toolset
  // lands so this stays heterogeneous like Python's `Sequence[Tool | Toolset]`.
  private _tools: ToolContextEntry<UserData>[] = [];
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- ToolContext stores generic function tools
  private _functionToolsMap: Map<string, FunctionTool<any, UserData, any>> = new Map();
  private _providerTools: ProviderDefinedTool[] = [];
  // TODO: toolset - populate when Toolset support is supported.
  // so the `toolsets` getter and `equals` toolset-identity check stay byte-compatible with the
  private _toolSets: unknown[] = [];

  // TODO: toolset - widen `tools` to `Sequence<Tool | Toolset>` once Toolset lands.
  constructor(tools: readonly ToolContextEntry<UserData>[] = []) {
    this.updateTools(tools);
  }

  static empty<UserData = UnknownUserData>(): ToolContext<UserData> {
    return new ToolContext<UserData>([]);
  }

  /** A copy of all function tools in the tool context, including those in tool sets. */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  get functionTools(): Record<string, FunctionTool<any, UserData, any>> {
    return Object.fromEntries(this._functionToolsMap);
  }

  /** A copy of all provider tools in the tool context, including those in tool sets. */
  get providerTools(): ProviderDefinedTool[] {
    return this._providerTools;
  }

  /**
   * A copy of all tool sets in the tool context.
   *
   * TODO: toolset - wire up once Toolset is ported.
   */
  get toolsets(): unknown[] {
    return this._toolSets;
  }

  /**
   * A copy of the raw tool list this context was constructed with.
   */
  get tools(): readonly ToolContextEntry<UserData>[] {
    return [...this._tools];
  }

  /** Flatten the tool context to a list of tools. */
  flatten(): Tool[] {
    return [...this._functionToolsMap.values(), ...this._providerTools];
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- Generic registry over any parameter/result types
  getFunctionTool(name: string): FunctionTool<any, UserData, any> | undefined {
    return this._functionToolsMap.get(name);
  }

  hasTool(name: string): boolean {
    if (this._functionToolsMap.has(name)) {
      return true;
    }
    return this._providerTools.some((tool) => tool.id === name);
  }

  // TODO: toolset - widen `tools` to `Sequence<Tool | Toolset>` once Toolset lands.
  updateTools(tools: readonly ToolContextEntry<UserData>[]): void {
    this._tools = [...tools];
    this._functionToolsMap = new Map();
    this._providerTools = [];
    this._toolSets = [];

    // Mirrors Python's recursive `add_tool` (minus Toolset flattening, which is TODO).
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- accepts any tool shape
    const addTool = (tool: any): void => {
      if (isProviderDefinedTool(tool)) {
        this._providerTools.push(tool);
        return;
      }

      if (isFunctionTool(tool)) {
        const existing = this._functionToolsMap.get(tool.name);
        if (existing !== undefined) {
          if (existing !== tool) {
            throw new Error(`duplicate function name: ${tool.name}`);
          }
          return; // same instance, skip
        }
        this._functionToolsMap.set(tool.name, tool);
        return;
      }

      // TODO: toolset - if (tool instanceof Toolset) { for (const t of tool.tools) addTool(t);
      //                  this._toolSets.push(tool); return; }

      throw new Error(`unknown tool type: ${typeof tool}`);
    };

    // TODO: toolset - Python also chains `find_function_tools(self)` here so subclasses can
    // declare tools as class members. JS doesn't use that decorator pattern, so we only walk
    // the explicit input list.
    for (const tool of tools) {
      addTool(tool);
    }
  }

  copy(): ToolContext<UserData> {
    return new ToolContext<UserData>([...this._tools]);
  }

  equals(other: ToolContext): boolean {
    if (this._functionToolsMap.size !== other._functionToolsMap.size) {
      return false;
    }
    for (const [name, tool] of this._functionToolsMap) {
      if (other._functionToolsMap.get(name) !== tool) {
        return false;
      }
    }
    if (this._providerTools.length !== other._providerTools.length) {
      return false;
    }
    // Provider tools compare as identity sets to match Python's `set(id(t) for t in ...)`
    // semantics — order is not significant.
    const otherProviderIds = new Set(other._providerTools);
    for (const tool of this._providerTools) {
      if (!otherProviderIds.has(tool)) {
        return false;
      }
    }
    // TODO: toolset - once Toolset lands, also compare `_toolSets` as identity sets per Python
    //   self_tool_set_ids = {id(ts) for ts in self._tool_sets}
    //   other_tool_set_ids = {id(ts) for ts in other._tool_sets}
    //   if self_tool_set_ids != other_tool_set_ids: return False
    return true;
  }
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
  name,
  description,
  parameters,
  execute,
  flags,
}: {
  name: string;
  description: string;
  parameters: Schema;
  execute: ToolExecuteFunction<InferToolInput<Schema>, UserData, Result>;
  flags?: number;
}): FunctionTool<InferToolInput<Schema>, UserData, Result>;

/**
 * Create a function tool without parameters.
 */
export function tool<UserData = UnknownUserData, Result = unknown>({
  name,
  description,
  execute,
  flags,
}: {
  name: string;
  description: string;
  parameters?: never;
  execute: ToolExecuteFunction<Record<string, never>, UserData, Result>;
  flags?: number;
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
    if (typeof tool.name !== 'string' || tool.name.length === 0) {
      throw new Error('tool({ name, ... }) requires a non-empty name');
    }

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
      name: tool.name,
      description: tool.description,
      parameters,
      execute: tool.execute,
      flags: tool.flags ?? ToolFlag.NONE,
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
