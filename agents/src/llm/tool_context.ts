// SPDX-FileCopyrightText: 2024 LiveKit, Inc.
//
// SPDX-License-Identifier: Apache-2.0
import type { ZodObject } from 'zod';
import { type infer as zodInfer } from 'zod';
import type { RunContext, UnknownUserData } from '../voice/run_context.js';

// heavily inspired by Vercel AI's `tool()`:
// https://github.com/vercel/ai/blob/3b0983b/packages/ai/core/tool/tool.ts

/* eslint-disable @typescript-eslint/no-explicit-any */

// TODO(brian): support raw JSON schema, both strict and non-strict versions
export type ToolParameters = ZodObject<any, any, any>;

/** Type reinforcement for the callable function's execute parameters. */
export type inferParameters<P extends ToolParameters> = zodInfer<P>;

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
  Parameters extends ToolParameters,
  UserData = UnknownUserData,
  Result = unknown,
> = (
  args: inferParameters<Parameters>,
  opts: ToolExecutionOptions<UserData>,
) => PromiseLike<Result>;

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
  Parameters extends ToolParameters,
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
  parameters: Parameters;

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
export function tool<
  Parameters extends ToolParameters,
  UserData = UnknownUserData,
  Result = unknown,
>({
  name,
  description,
  parameters,
  execute,
}: {
  name: string;
  description: string;
  parameters: Parameters;
  execute: ToolExecuteFunction<Parameters, UserData, Result>;
}): FunctionTool<Parameters, UserData, Result> {
  return {
    type: 'function',
    name,
    description,
    parameters,
    execute,
  };
}
