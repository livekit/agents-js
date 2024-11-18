// SPDX-FileCopyrightText: 2024 LiveKit, Inc.
//
// SPDX-License-Identifier: Apache-2.0
import { z } from 'zod';

// heavily inspired by Vercel AI's `tool()`:
// https://github.com/vercel/ai/blob/3b0983b/packages/ai/core/tool/tool.ts

/* eslint-disable @typescript-eslint/no-explicit-any */

/** Type reinforcement for the callable function's execute parameters. */
export type inferParameters<P extends z.ZodTypeAny> = z.infer<P>;

/** Raw OpenAI-adherent function parameters. */
export type OpenAIFunctionParameters = {
  type: 'object';
  properties: { [id: string]: any };
  required: string[];
  additionalProperties: boolean;
};

/** A definition for a function callable by the LLM. */
export interface CallableFunction<P extends z.ZodTypeAny = any, R = any> {
  description: string;
  parameters: OpenAIFunctionParameters | P;
  execute: (args: inferParameters<P>) => PromiseLike<R>;
}

/** A function that has been called but is not yet running */
export interface FunctionCallInfo<P extends z.ZodTypeAny = any, R = any> {
  name: string;
  func: CallableFunction<P, R>;
  toolCallId: string;
  rawParams: string;
  params: inferParameters<P>;
  task?: PromiseLike<CallableFunctionResult>;
}

/** The result of a ran FunctionCallInfo. */
export interface CallableFunctionResult {
  name: string;
  toolCallId: string;
  result?: any;
  error?: any;
}

/** An object containing callable functions and their names */
export type FunctionContext = {
  [name: string]: CallableFunction;
};

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
export const oaiParams = (p: z.AnyZodObject) => {
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
  fncCtx: FunctionContext,
  toolCallId: string,
  fncName: string,
  rawArgs: string,
): FunctionCallInfo => {
  const func = fncCtx[fncName];
  if (!func) {
    throw new Error(`AI function ${fncName} not found`);
  }

  return {
    name: fncName,
    func,
    toolCallId,
    rawParams: rawArgs,
    params: JSON.parse(rawArgs),
  };
};
