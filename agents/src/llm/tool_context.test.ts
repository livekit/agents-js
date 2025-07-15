// SPDX-FileCopyrightText: 2024 LiveKit, Inc.
//
// SPDX-License-Identifier: Apache-2.0
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { type ToolOptions, tool } from './tool_context.js';
import { createToolOptions, oaiParams } from './utils.js';

describe('Tool Context', () => {
  describe('oaiParams', () => {
    it('should handle basic object schema', () => {
      const schema = z.object({
        name: z.string().describe('The user name'),
        age: z.number().describe('The user age'),
      });

      const result = oaiParams(schema);

      expect(result).toMatchSnapshot();
    });

    it('should handle enum fields', () => {
      const schema = z.object({
        color: z.enum(['red', 'blue', 'green']).describe('Choose a color'),
      });

      const result = oaiParams(schema);

      expect(result).toMatchSnapshot();
    });

    it('should handle array fields', () => {
      const schema = z.object({
        tags: z.array(z.string()).describe('List of tags'),
      });

      const result = oaiParams(schema);

      expect(result).toMatchSnapshot();
    });

    it('should handle array of enums', () => {
      const schema = z.object({
        colors: z.array(z.enum(['red', 'blue', 'green'])).describe('List of colors'),
      });

      const result = oaiParams(schema);

      expect(result).toMatchSnapshot();
    });

    it('should handle optional fields', () => {
      const schema = z.object({
        name: z.string().describe('The user name'),
        age: z.number().optional().describe('The user age'),
      });

      const result = oaiParams(schema);

      expect(result).toMatchSnapshot();
    });

    it('should handle fields without descriptions', () => {
      const schema = z.object({
        name: z.string(),
        age: z.number(),
      });

      const result = oaiParams(schema);

      expect(result).toMatchSnapshot();
    });
  });

  describe('tool', () => {
    it('should create and execute a basic core tool', async () => {
      const getWeather = tool({
        description: 'Get the weather for a given location',
        parameters: z.object({
          location: z.string(),
        }),
        execute: async ({ location }, { ctx }: ToolOptions<{ name: string }>) => {
          return `The weather in ${location} is sunny, ${ctx.userData.name}`;
        },
      });

      const result = await getWeather.execute(
        { location: 'San Francisco' },
        createToolOptions('123', { name: 'John' }),
      );
      expect(result).toBe('The weather in San Francisco is sunny, John');
    });

    it('should properly type a callable function', async () => {
      const testFunction = tool({
        description: 'Test function',
        parameters: z.object({
          name: z.string().describe('The user name'),
          age: z.number().describe('The user age'),
        }),
        execute: async (args) => {
          return `${args.name} is ${args.age} years old`;
        },
      });

      const result = await testFunction.execute(
        { name: 'John', age: 30 },
        createToolOptions('123'),
      );
      expect(result).toBe('John is 30 years old');
    });

    it('should handle async execution', async () => {
      const testFunction = tool({
        description: 'Async test function',
        parameters: z.object({
          delay: z.number().describe('Delay in milliseconds'),
        }),
        execute: async (args) => {
          await new Promise((resolve) => setTimeout(resolve, args.delay));
          return args.delay;
        },
      });

      const start = Date.now();
      const result = await testFunction.execute({ delay: 100 }, createToolOptions('123'));
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
        expect(result).toMatchSnapshot();
      });
    });

    describe('optional parameters', () => {
      it('should create a tool without parameters', async () => {
        const simpleAction = tool({
          description: 'Perform a simple action',
          execute: async () => {
            return 'Action performed';
          },
        });

        expect(simpleAction.type).toBe('function');
        expect(simpleAction.description).toBe('Perform a simple action');
        expect(simpleAction.parameters).toBeDefined();
        expect(simpleAction.parameters._def.typeName).toBe('ZodObject');

        const result = await simpleAction.execute({}, createToolOptions('123'));
        expect(result).toBe('Action performed');
      });

      it('should handle tools with context but no parameters', async () => {
        const greetUser = tool({
          description: 'Greet the current user',
          execute: async (_, { ctx }: ToolOptions<{ username: string }>) => {
            return `Hello, ${ctx.userData.username}!`;
          },
        });

        const result = await greetUser.execute({}, createToolOptions('123', { username: 'Alice' }));
        expect(result).toBe('Hello, Alice!');
      });

      it('should create a tool that accesses tool call id without parameters', async () => {
        const getCallId = tool({
          description: 'Get the current tool call ID',
          execute: async (_, { toolCallId }) => {
            return `Tool call ID: ${toolCallId}`;
          },
        });

        const result = await getCallId.execute({}, createToolOptions('test-id-456'));
        expect(result).toBe('Tool call ID: test-id-456');
      });
    });
  });
});
