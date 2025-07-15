// SPDX-FileCopyrightText: 2024 LiveKit, Inc.
//
// SPDX-License-Identifier: Apache-2.0
import { describe, expect, expectTypeOf, it } from 'vitest';
import { z } from 'zod';
import { type FunctionTool, type ProviderDefinedTool, type ToolOptions, tool } from './index.js';

describe('tool type inference', () => {
  it('should infer argument type from zod schema', () => {
    const toolType = tool({
      description: 'test',
      parameters: z.object({ number: z.number() }),
      execute: async () => 'test' as const,
    });

    expectTypeOf(toolType).toEqualTypeOf<FunctionTool<{ number: number }, unknown, 'test'>>();
  });

  it('should infer provider defined tool type', () => {
    const toolType = tool({
      id: 'code-interpreter',
      config: {
        language: 'python',
      },
    });

    expectTypeOf(toolType).toEqualTypeOf<ProviderDefinedTool>();
  });

  it('should infer run context type', () => {
    const toolType = tool({
      description: 'test',
      parameters: z.object({ number: z.number() }),
      execute: async ({ number }, { ctx }: ToolOptions<{ name: string }>) => {
        return `The number is ${number}, ${ctx.userData.name}`;
      },
    });

    expectTypeOf(toolType).toEqualTypeOf<
      FunctionTool<{ number: number }, { name: string }, string>
    >();
  });

  it('should not accept primitive zod schemas', () => {
    expect(() => {
      // @ts-expect-error - Testing that non-object schemas are rejected
      tool({
        name: 'test',
        description: 'test',
        parameters: z.string(),
        execute: async () => 'test' as const,
      });
    }).toThrowError('Tool parameters must be a Zod object schema (z.object(...))');
  });

  it('should not accept array schemas', () => {
    expect(() => {
      // @ts-expect-error - Testing that array schemas are rejected
      tool({
        name: 'test',
        description: 'test',
        parameters: z.array(z.string()),
        execute: async () => 'test' as const,
      });
    }).toThrowError('Tool parameters must be a Zod object schema (z.object(...))');
  });

  it('should not accept union schemas', () => {
    expect(() => {
      // @ts-expect-error - Testing that union schemas are rejected
      tool({
        name: 'test',
        description: 'test',
        parameters: z.union([z.object({ a: z.string() }), z.object({ b: z.number() })]),
        execute: async () => 'test' as const,
      });
    }).toThrowError('Tool parameters must be a Zod object schema (z.object(...))');
  });

  it('should not accept non-Zod values as parameters', () => {
    expect(() => {
      // @ts-expect-error - Testing that non-Zod values are rejected
      tool({
        name: 'test',
        description: 'test',
        parameters: 'invalid schema',
        execute: async () => 'test' as const,
      });
    }).toThrowError('Tool parameters must be a Zod object schema or a raw JSON schema');
  });

  it('should infer empty object type when parameters are omitted', () => {
    const toolType = tool({
      description: 'Simple action without parameters',
      execute: async () => 'done' as const,
    });

    expectTypeOf(toolType).toEqualTypeOf<FunctionTool<Record<string, never>, unknown, 'done'>>();
  });

  it('should infer correct types with context but no parameters', () => {
    const toolType = tool({
      description: 'Action with context',
      execute: async (args, { ctx }: ToolOptions<{ userId: number }>) => {
        expectTypeOf(args).toEqualTypeOf<Record<string, never>>();
        expectTypeOf(ctx.userData.userId).toEqualTypeOf<number>();
        return ctx.userData.userId;
      },
    });

    expectTypeOf(toolType).toEqualTypeOf<
      FunctionTool<Record<string, never>, { userId: number }, number>
    >();
  });
});
