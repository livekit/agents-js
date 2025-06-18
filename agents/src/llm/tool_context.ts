// SPDX-FileCopyrightText: 2024 LiveKit, Inc.
//
// SPDX-License-Identifier: Apache-2.0
import { type ZodObject, ZodType } from 'zod';
import type { RunContext, UnknownUserData } from '../voice/run_context.js';

// heavily inspired by Vercel AI's `tool()`:
// https://github.com/vercel/ai/blob/3b0983b/packages/ai/core/tool/tool.ts

/* eslint-disable @typescript-eslint/no-explicit-any */

export type JSONValue = null | string | number | boolean | JSONObject | JSONArray;

export type JSONArray = JSONValue[];

export type JSONObject = {
  [key: string]: JSONValue;
};

// TODO(brian): support raw JSON schema, both strict and non-strict versions
export type ToolInputSchema<T extends JSONObject> = ZodObject<any, any, any, T, T>;

export type ToolType = 'function' | 'provider-defined';

export interface ToolExecutionOptions<UserData = UnknownUserData> {
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
> = (args: Parameters, opts: ToolExecutionOptions<UserData>) => PromiseLike<Result>;

export interface Tool {
  /**
   * The type of the tool.
   * @internal Either user-defined core tool or provider-defined tool.
   */
  type: ToolType;

  /**
   * The name of the tool.
   */
  name: string;
}

// TODO(brian): support provider-defined tools
export interface ProviderDefinedTool extends Tool {
  type: 'provider-defined';

  /**
   * The configuration of the tool.
   */
  config: Record<string, unknown>;
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
}

// TODO(brian: support provider-defined tools in the future)
export type ToolContext = {
  [name: string]: FunctionTool<any, any, any>; // eslint-disable-line @typescript-eslint/no-explicit-any
};

/**
 * Create a function tool.
 *
 * @param name - The name of the tool.
 * @param description - The description of the tool.
 * @param parameters - The schema of the input that the tool expects.
 * @param execute - The function that is called with the arguments from the tool call and produces a result.
 */
export function tool<Parameters extends JSONObject, UserData = UnknownUserData, Result = unknown>({
  name,
  description,
  parameters,
  execute,
}: {
  name: string;
  description: string;
  parameters: ToolInputSchema<Parameters>;
  execute: ToolExecuteFunction<Parameters, UserData, Result>;
}): FunctionTool<Parameters, UserData, Result>;

export function tool({
  name,
  config,
}: {
  name: string;
  config: Record<string, unknown>;
}): ProviderDefinedTool;

export function tool(tool: any): any {
  if (tool.parameters !== undefined && tool.execute !== undefined) {
    // if parameters is not zod object, throw an error
    if (!(tool.parameters instanceof ZodType)) {
      throw new Error('Tool parameters must be a Zod schema');
    }

    // Check if it's specifically a ZodObject (not other Zod types like ZodString, ZodNumber, etc.)
    if (tool.parameters._def.typeName !== 'ZodObject') {
      throw new Error('Tool parameters must be a Zod object schema (z.object(...))');
    }

    return {
      type: 'function',
      name: tool.name,
      description: tool.description,
      parameters: tool.parameters,
      execute: tool.execute,
    };
  }

  if (tool.config !== undefined) {
    return {
      type: 'provider-defined',
      name: tool.name,
      config: tool.config,
    };
  }

  throw new Error('Invalid tool');
}
