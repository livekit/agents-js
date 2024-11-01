// SPDX-FileCopyrightText: 2024 LiveKit, Inc.
//
// SPDX-License-Identifier: Apache-2.0
import { z } from 'zod';

// heavily inspired by Vercel AI's `tool()`:
// https://github.com/vercel/ai/blob/3b0983b/packages/ai/core/tool/tool.ts

/* eslint-disable @typescript-eslint/no-explicit-any */

/** Type reinforcement for the callable function's execute parameters. */
export type inferParameters<P extends z.ZodTypeAny> = z.infer<P>;

/** A definition for a function callable by the LLM. */
export interface CallableFunction<P extends z.ZodTypeAny = any, R = any> {
  description: string;
  parameters: P;
  execute: (args: inferParameters<P>) => PromiseLike<R>;
}

/** An object containing callable functions and their names */
export type FunctionContext = {
  [name: string]: CallableFunction;
};

/** @internal */
export const oaiParams = (p: z.AnyZodObject) => {
  const properties: Record<string, any> = {};
  const required_properties: string[] = [];

  for (const key in p.shape) {
    const field = p.shape[key];
    const description = field._def.description || undefined;
    let type: string;
    let enumValues: any[] | undefined;
    let items: any = undefined;

    const isOptional = field instanceof z.ZodOptional;
    const nestedField = isOptional ? field._def.innerType : field;

    if (nestedField instanceof z.ZodEnum) {
      enumValues = nestedField._def.values;
      type = typeof enumValues![0];
    } else if (nestedField instanceof z.ZodArray) {
      type = 'array';
      const elementType = nestedField._def.type;
      items = {
        type: elementType._def.typeName.toLowerCase().includes('zod')
          ? elementType._def.typeName.toLowerCase().substring(3)
          : elementType._def.typeName.toLowerCase(),
      };

      if (elementType instanceof z.ZodEnum) {
        items.enum = elementType._def.values;
      }
    } else {
      type = nestedField._def.typeName.toLowerCase();
      type = type.includes('zod') ? type.substring(3) : type;
    }

    properties[key] = {
      type,
      description,
      ...(enumValues && { enum: enumValues }),
      ...(items && { items }),
    };

    if (!isOptional) {
      required_properties.push(key);
    }
  }

  const type = 'object' as const;
  return {
    type,
    properties,
    required_properties,
  };
};
