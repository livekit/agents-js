// SPDX-FileCopyrightText: 2024 LiveKit, Inc.
//
// SPDX-License-Identifier: Apache-2.0
import { describe, expect, expectTypeOf, it } from 'vitest';
import { z } from 'zod';
import {
  type FunctionTool,
  ProviderTool,
  type Tool,
  ToolContext,
  type ToolContextInit,
  type ToolContextLike,
  type ToolDefinitionMap,
  type ToolOptions,
  tool,
} from './tool_context.js';

describe('tool type inference', () => {
  it('should infer argument type from zod schema', () => {
    const toolType = tool({
      name: 'test',
      description: 'test',
      parameters: z.object({ number: z.number() }),
      execute: async () => 'test' as const,
    });

    expectTypeOf(toolType).toEqualTypeOf<FunctionTool<{ number: number }, unknown, 'test'>>();
  });

  it('should infer argument type for an anonymous (name-less) tool with a schema', () => {
    tool({
      description: 'test',
      parameters: z.object({ number: z.number() }),
      execute: async (args) => {
        expectTypeOf(args).toEqualTypeOf<{ number: number }>();
        return `${args.number}` as const;
      },
    });
  });

  it('rejects direct instantiation of the abstract ProviderTool base', () => {
    // @ts-expect-error - ProviderTool is abstract; plugins must subclass it.
    new ProviderTool({ id: 'code-interpreter' });

    class CodeInterpreter extends ProviderTool {}
    const providerTool = new CodeInterpreter({ id: 'code-interpreter' });
    expectTypeOf(providerTool).toMatchTypeOf<ProviderTool>();
    expect(providerTool.id).toBe('code-interpreter');
    expect(providerTool.type).toBe('provider');
  });

  it('should infer run context type', () => {
    const toolType = tool({
      name: 'test',
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
      tool({
        name: 'test',
        description: 'test',
        // @ts-expect-error - Testing that non-Zod values are rejected
        parameters: 'invalid schema',
        execute: async () => 'test' as const,
      });
    }).toThrowError('Tool parameters must be a Zod object schema or a raw JSON schema');
  });

  it('should infer empty object type when parameters are omitted', () => {
    const toolType = tool({
      name: 'simpleAction',
      description: 'Simple action without parameters',
      execute: async () => 'done' as const,
    });

    expectTypeOf(toolType).toEqualTypeOf<FunctionTool<Record<string, never>, unknown, 'done'>>();
  });

  it('names tool context input shapes by role', () => {
    const objectTools = {
      lookupOrder: tool({
        description: 'Look up an order',
        execute: async () => 'done' as const,
      }),
    };
    const namedTool = tool({
      name: 'simpleAction',
      description: 'Simple action',
      execute: async () => 'done' as const,
    });

    expectTypeOf(objectTools).toMatchTypeOf<ToolDefinitionMap>();
    expectTypeOf(objectTools).toMatchTypeOf<ToolContextInit>();
    expectTypeOf([namedTool]).toMatchTypeOf<ToolContextInit>();
    expectTypeOf(new ToolContext(objectTools)).toMatchTypeOf<ToolContextLike>();
    expectTypeOf(namedTool).toMatchTypeOf<Tool>();
  });

  it('should infer correct types with context but no parameters', () => {
    const toolType = tool({
      name: 'actionWithCtx',
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
