// SPDX-FileCopyrightText: 2024 LiveKit, Inc.
//
// SPDX-License-Identifier: Apache-2.0
import { ZodObject, z, type infer as zodInfer } from 'zod';
import type { RunContext, UnknownUserData } from '../voice/run_context.js';
import { FunctionCall } from './chat_context.js';

// heavily inspired by Vercel AI's `tool()`:
// https://github.com/vercel/ai/blob/3b0983b/packages/ai/core/tool/tool.ts

/* eslint-disable @typescript-eslint/no-explicit-any */

// TODO(brian): support raw JSON schema, both strict and non-strict versions
type ToolParameters = ZodObject<any>;

/** Type reinforcement for the callable function's execute parameters. */
type inferParameters<P extends ToolParameters> = zodInfer<P>;

export type ToolType = 'function' | 'provider-defined';

export interface ToolExecutionOptions<UserData = UnknownUserData> {
  /**
   * RunContext for the current agent session.
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
export type ToolContext = Record<string, FunctionTool<any, any, any>>;

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

// XXX: Zod is victim to the dual-package hazard. this is a hacky sorta-fix
// until Zod v4.0.0 is released.
// https://github.com/colinhacks/zod/issues/2241#issuecomment-2142688925
const looksLikeInstanceof = <T>(value: unknown, target: new (...args: any[]) => T): value is T => {
  let current = value?.constructor;
  do {
    if (current?.name === target.name) return true;
    // eslint-disable-next-line @typescript-eslint/ban-types
    current = Object.getPrototypeOf(current) as Function;
  } while (current?.name);
  return false;
};

/** @internal */
export const oaiParams = (p: ToolParameters) => {
  const properties: Record<string, any> = {};
  const requiredProperties: string[] = [];

  const processZodType = (field: z.ZodTypeAny): any => {
    const isOptional = field instanceof z.ZodOptional;
    const nestedField = isOptional ? field._def.innerType : field;
    const description = field._def.description;

    if (looksLikeInstanceof(nestedField, z.ZodEnum)) {
      return {
        type: typeof nestedField._def.values[0],
        ...(description && { description }),
        enum: nestedField._def.values,
      };
    } else if (looksLikeInstanceof(nestedField, z.ZodArray)) {
      const elementType = nestedField._def.type;
      return {
        type: 'array',
        ...(description && { description }),
        items: processZodType(elementType),
      };
    } else if (looksLikeInstanceof(nestedField, z.ZodObject)) {
      const { properties, required } = oaiParams(nestedField);
      return {
        type: 'object',
        ...(description && { description }),
        properties,
        required,
      };
    } else {
      let type = nestedField._def.typeName.toLowerCase();
      type = type.includes('zod') ? type.substring(3) : type;
      return {
        type,
        ...(description && { description }),
      };
    }
  };

  for (const key in p.shape) {
    const field = p.shape[key];
    properties[key] = processZodType(field);

    if (!(field instanceof z.ZodOptional)) {
      requiredProperties.push(key);
    }
  }

  const type = 'object' as const;
  return {
    type,
    properties,
    required: requiredProperties,
  };
};

/** @internal */
export const oaiBuildFunctionInfo = (
  toolCtx: ToolContext,
  toolCallId: string,
  toolName: string,
  rawArgs: string,
): FunctionCall => {
  const tool = toolCtx[toolName];
  if (!tool) {
    throw new Error(`AI tool ${toolName} not found`);
  }

  return FunctionCall.create({
    callId: toolCallId,
    name: toolName,
    args: rawArgs,
  });
};

