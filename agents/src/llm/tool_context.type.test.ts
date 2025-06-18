// SPDX-FileCopyrightText: 2024 LiveKit, Inc.
//
// SPDX-License-Identifier: Apache-2.0
import { describe, expect, expectTypeOf, it } from 'vitest';
import { z } from 'zod';
import { tool, type FunctionTool } from './index.js';

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

  it("should not accept primitive zod schemas", () => {
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

  it("should not accept array schemas", () => {
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

  it("should not accept union schemas", () => {
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

  it("should not accept non-Zod values as parameters", () => {
    expect(() => {
      // @ts-expect-error - Testing that non-Zod values are rejected
      tool({
        name: 'test',
        description: 'test',
        parameters: { notAZodSchema: true },
        execute: async () => 'test' as const,
      });
    }).toThrowError('Tool parameters must be a Zod schema');
  });
}); 