import type { ZodObject, infer as zodInfer } from 'zod';
import type { RunContext, UnknownUserData } from '../voice/run_context.js';

// heavily inspired by Vercel AI's `tool()`:
// https://github.com/vercel/ai/blob/3b0983b/packages/ai/core/tool/tool.ts

/* eslint-disable @typescript-eslint/no-explicit-any */

// TODO(brian): support raw JSON schema, both strict and non-strict versions
type ToolParameters = ZodObject<any>;

/** Type reinforcement for the callable function's execute parameters. */
type inferParameters<P extends ToolParameters> = zodInfer<P>;

export type ToolType = 'core' | 'provider-defined';

export type ToolExecuteFunction<
  Parameters extends ToolParameters,
  UserData = UnknownUserData,
  Result = unknown,
> = (
  args: inferParameters<Parameters>,
  opts: ToolExecutionOptions<UserData>,
) => PromiseLike<Result>;

export interface ToolExecutionOptions<UserData = UnknownUserData> {
  /**
   * RunContext
   */
  ctx: RunContext<UserData>;

  /**
   * The ID of the tool call. You can use it e.g. when sending tool-call related information with stream data.
   */
  toolCallId: string;

  /**
   * An optional abort signal that indicates that the overall operation should be aborted.
   */
  abortSignal?: AbortSignal;
}

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
export interface ProviderDefinedTool<
  Parameters extends ToolParameters,
  UserData = UnknownUserData,
  Result = unknown,
> extends Tool {
  type: 'provider-defined';
}

export interface CoreTool<
  Parameters extends ToolParameters,
  UserData = UnknownUserData,
  Result = unknown,
> extends Tool {
  type: 'core';

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
}): CoreTool<Parameters, UserData, Result> {
  return {
    type: 'core',
    name,
    description,
    parameters,
    execute,
  };
}
