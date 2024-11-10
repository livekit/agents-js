// SPDX-FileCopyrightText: 2024 LiveKit, Inc.
//
// SPDX-License-Identifier: Apache-2.0
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import type { CallableFunction } from './function_context.js';
import { oaiParams } from './function_context.js';

describe('function_context', () => {
  describe('oaiParams', () => {
    it('should handle basic object schema', () => {
      const schema = z.object({
        name: z.string().describe('The user name'),
        age: z.number().describe('The user age'),
      });

      const result = oaiParams(schema);

      expect(result).toEqual({
        type: 'object',
        properties: {
          name: {
            type: 'string',
            description: 'The user name',
          },
          age: {
            type: 'number',
            description: 'The user age',
          },
        },
        required: ['name', 'age'],
      });
    });

    it('should handle enum fields', () => {
      const schema = z.object({
        color: z.enum(['red', 'blue', 'green']).describe('Choose a color'),
      });

      const result = oaiParams(schema);

      expect(result).toEqual({
        type: 'object',
        properties: {
          color: {
            type: 'string',
            description: 'Choose a color',
            enum: ['red', 'blue', 'green'],
          },
        },
        required: ['color'],
      });
    });

    it('should handle array fields', () => {
      const schema = z.object({
        tags: z.array(z.string()).describe('List of tags'),
      });

      const result = oaiParams(schema);

      expect(result).toEqual({
        type: 'object',
        properties: {
          tags: {
            type: 'array',
            description: 'List of tags',
            items: {
              type: 'string',
            },
          },
        },
        required: ['tags'],
      });
    });

    it('should handle array of enums', () => {
      const schema = z.object({
        colors: z.array(z.enum(['red', 'blue', 'green'])).describe('List of colors'),
      });

      const result = oaiParams(schema);

      expect(result).toEqual({
        type: 'object',
        properties: {
          colors: {
            type: 'array',
            description: 'List of colors',
            items: {
              type: 'string',
              enum: ['red', 'blue', 'green'],
            },
          },
        },
        required: ['colors'],
      });
    });

    it('should handle optional fields', () => {
      const schema = z.object({
        name: z.string().describe('The user name'),
        age: z.number().optional().describe('The user age'),
      });

      const result = oaiParams(schema);

      expect(result).toEqual({
        type: 'object',
        properties: {
          name: {
            type: 'string',
            description: 'The user name',
          },
          age: {
            type: 'number',
            description: 'The user age',
          },
        },
        required: ['name'], // age should not be required
      });
    });

    it('should handle fields without descriptions', () => {
      const schema = z.object({
        name: z.string(),
        age: z.number(),
      });

      const result = oaiParams(schema);

      expect(result).toEqual({
        type: 'object',
        properties: {
          name: {
            type: 'string',
            description: undefined,
          },
          age: {
            type: 'number',
            description: undefined,
          },
        },
        required: ['name', 'age'],
      });
    });
  });

  describe('CallableFunction type', () => {
    it('should properly type a callable function', async () => {
      const schema = z.object({
        name: z.string().describe('The user name'),
        age: z.number().describe('The user age'),
      });

      const testFunction: CallableFunction<typeof schema, string> = {
        description: 'Test function',
        parameters: schema,
        execute: async (args: z.infer<typeof schema>) => {
          // TypeScript should recognize args.name and args.age
          return `${args.name} is ${args.age} years old`;
        },
      };

      const result = await testFunction.execute({ name: 'John', age: 30 });
      expect(result).toBe('John is 30 years old');
    });

    it('should handle async execution', async () => {
      const schema = z.object({
        delay: z.number().describe('Delay in milliseconds'),
      });

      const testFunction: CallableFunction<typeof schema, number> = {
        description: 'Async test function',
        parameters: schema,
        execute: async (args: z.infer<typeof schema>) => {
          await new Promise((resolve) => setTimeout(resolve, args.delay));
          return args.delay;
        },
      };

      const start = Date.now();
      const result = await testFunction.execute({ delay: 100 });
      const duration = Date.now() - start;

      expect(result).toBe(100);
      expect(duration).toBeGreaterThanOrEqual(95); // Allow for small timing variations
    });

    describe('nested array support', () => {
      it('should handle nested array fields', () => {
        const schema = z.object({
          items: z.array(
            z.object({
              name: z.string().describe('the item name'),
              modifiers: z
                .array(
                  z.object({
                    modifier_name: z.string(),
                    modifier_value: z.string(),
                  }),
                )
                .describe('list of the modifiers applied on this item, such as size'),
            }),
          ),
        });
        const result = oaiParams(schema);
        expect(result).toEqual({
          type: 'object',
          properties: {
            items: {
              type: 'array',
              description: undefined,
              items: {
                type: 'object',
                properties: {
                  name: {
                    type: 'string',
                    description: 'the item name',
                  },
                  modifiers: {
                    type: 'array',
                    description: 'list of the modifiers applied on this item, such as size',
                    items: {
                      type: 'object',
                      properties: {
                        modifier_name: {
                          type: 'string',
                        },
                        modifier_value: {
                          type: 'string',
                        },
                      },
                      required: ['modifier_name', 'modifier_value'],
                    },
                  },
                },
                required: ['name', 'modifiers'],
              },
            },
          },
          required: ['items'],
        });
      });
    });
  });
});
