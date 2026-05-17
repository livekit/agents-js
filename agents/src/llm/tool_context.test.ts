// SPDX-FileCopyrightText: 2024 LiveKit, Inc.
//
// SPDX-License-Identifier: Apache-2.0
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import * as z3 from 'zod/v3';
import * as z4 from 'zod/v4';
import { ToolContext, type ToolOptions, tool } from './tool_context.js';
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
        name: 'getWeather',
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
        name: 'testFunction',
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
        name: 'asyncTestFunction',
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
          name: 'simpleAction',
          description: 'Perform a simple action',
          execute: async () => {
            return 'Action performed';
          },
        });

        expect(simpleAction.type).toBe('function');
        expect(simpleAction.description).toBe('Perform a simple action');
        expect(simpleAction.parameters).toBeDefined();
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        expect((simpleAction.parameters as any)._def.typeName).toBe('ZodObject');

        const result = await simpleAction.execute({}, createToolOptions('123'));
        expect(result).toBe('Action performed');
      });

      it('should support .optional() fields in tool parameters', async () => {
        const weatherTool = tool({
          name: 'weatherTool',
          description: 'Get weather information',
          parameters: z.object({
            location: z.string().describe('The city or location').optional(),
            units: z.enum(['celsius', 'fahrenheit']).describe('Temperature units').optional(),
          }),
          execute: async ({ location, units }) => {
            const loc = location ?? 'Unknown';
            const unit = units ?? 'celsius';
            return `Weather in ${loc} (${unit})`;
          },
        });

        expect(weatherTool.type).toBe('function');
        expect(weatherTool.description).toBe('Get weather information');

        const result1 = await weatherTool.execute(
          { location: 'London', units: 'celsius' },
          createToolOptions('123'),
        );
        expect(result1).toBe('Weather in London (celsius)');

        const result2 = await weatherTool.execute({}, createToolOptions('123'));
        expect(result2).toBe('Weather in Unknown (celsius)');

        const result3 = await weatherTool.execute({ location: 'Paris' }, createToolOptions('123'));
        expect(result3).toBe('Weather in Paris (celsius)');
      });

      it('should handle tools with context but no parameters', async () => {
        const greetUser = tool({
          name: 'greetUser',
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
          name: 'getCallId',
          description: 'Get the current tool call ID',
          execute: async (_, { toolCallId }) => {
            return `Tool call ID: ${toolCallId}`;
          },
        });

        const result = await getCallId.execute({}, createToolOptions('test-id-456'));
        expect(result).toBe('Tool call ID: test-id-456');
      });
    });

    describe('Zod v3 and v4 compatibility', () => {
      it('should work with Zod v3 schemas', async () => {
        const v3Tool = tool({
          name: 'v3Tool',
          description: 'A tool using Zod v3 schema',
          parameters: z3.object({
            name: z3.string(),
            count: z3.number(),
          }),
          execute: async ({ name, count }) => {
            return `${name}: ${count}`;
          },
        });

        const result = await v3Tool.execute(
          { name: 'Test', count: 42 },
          createToolOptions('v3-test'),
        );
        expect(result).toBe('Test: 42');
      });

      it('should work with Zod v4 schemas', async () => {
        const v4Tool = tool({
          name: 'v4Tool',
          description: 'A tool using Zod v4 schema',
          parameters: z4.object({
            name: z4.string(),
            count: z4.number(),
          }),
          execute: async ({ name, count }) => {
            return `${name}: ${count}`;
          },
        });

        const result = await v4Tool.execute(
          { name: 'Test', count: 42 },
          createToolOptions('v4-test'),
        );
        expect(result).toBe('Test: 42');
      });

      it('should handle v4 schemas with optional fields', async () => {
        const v4Tool = tool({
          name: 'v4OptionalTool',
          description: 'Tool with optional field using v4',
          parameters: z4.object({
            required: z4.string(),
            optional: z4.string().optional(),
          }),
          execute: async ({ required, optional }) => {
            return optional ? `${required} - ${optional}` : required;
          },
        });

        const result1 = await v4Tool.execute({ required: 'Hello' }, createToolOptions('test-1'));
        expect(result1).toBe('Hello');

        const result2 = await v4Tool.execute(
          { required: 'Hello', optional: 'World' },
          createToolOptions('test-2'),
        );
        expect(result2).toBe('Hello - World');
      });

      it('should handle v4 enum schemas', async () => {
        const v4Tool = tool({
          name: 'v4EnumTool',
          description: 'Tool with enum using v4',
          parameters: z4.object({
            color: z4.enum(['red', 'blue', 'green']),
          }),
          execute: async ({ color }) => {
            return `Selected color: ${color}`;
          },
        });

        const result = await v4Tool.execute({ color: 'blue' }, createToolOptions('test-enum'));
        expect(result).toBe('Selected color: blue');
      });

      it('should handle v4 array schemas', async () => {
        const v4Tool = tool({
          name: 'v4ArrayTool',
          description: 'Tool with array using v4',
          parameters: z4.object({
            tags: z4.array(z4.string()),
          }),
          execute: async ({ tags }) => {
            return `Tags: ${tags.join(', ')}`;
          },
        });

        const result = await v4Tool.execute(
          { tags: ['nodejs', 'typescript', 'testing'] },
          createToolOptions('test-array'),
        );
        expect(result).toBe('Tags: nodejs, typescript, testing');
      });

      it('should handle v4 nested object schemas', async () => {
        const v4Tool = tool({
          name: 'v4NestedTool',
          description: 'Tool with nested object using v4',
          parameters: z4.object({
            user: z4.object({
              name: z4.string(),
              email: z4.string(),
            }),
          }),
          execute: async ({ user }) => {
            return `${user.name} (${user.email})`;
          },
        });

        const result = await v4Tool.execute(
          { user: { name: 'John Doe', email: 'john@example.com' } },
          createToolOptions('test-nested'),
        );
        expect(result).toBe('John Doe (john@example.com)');
      });
    });

    describe('oaiParams with v4 schemas', () => {
      it('should convert v4 basic object schema', () => {
        const schema = z4.object({
          name: z4.string().describe('User name'),
          age: z4.number().describe('User age'),
        });

        const result = oaiParams(schema);

        expect(result.type).toBe('object');
        expect(result.properties).toHaveProperty('name');
        expect(result.properties).toHaveProperty('age');
        expect(result.required).toContain('name');
        expect(result.required).toContain('age');
      });

      it('should handle v4 optional fields', () => {
        const schema = z4.object({
          required: z4.string(),
          optional: z4.string().optional(),
        });

        const result = oaiParams(schema);

        expect(result.required).toContain('required');
        expect(result.required).not.toContain('optional');
      });

      it('should handle v4 enum fields', () => {
        const schema = z4.object({
          status: z4.enum(['pending', 'approved', 'rejected']),
        });

        const result = oaiParams(schema);

        const properties = result.properties as Record<string, Record<string, unknown>>;
        expect(properties.status?.enum).toEqual(['pending', 'approved', 'rejected']);
      });

      it('should handle v4 array fields', () => {
        const schema = z4.object({
          items: z4.array(z4.string()),
        });

        const result = oaiParams(schema);

        const properties = result.properties as Record<string, any>;
        expect(
          properties.items && typeof properties.items === 'object'
            ? properties.items.type
            : undefined,
        ).toBe('array');
        expect(
          properties.items && properties.items.items && typeof properties.items.items === 'object'
            ? properties.items.items.type
            : undefined,
        ).toBe('string');
      });
    });
  });
});

describe('tool() name requirement', () => {
  it('throws when name is missing', () => {
    expect(() =>
      // @ts-expect-error - name is required
      tool({
        description: 'no name',
        execute: async () => 'x',
      }),
    ).toThrow('requires a non-empty name');
  });

  it('throws when name is empty', () => {
    expect(() =>
      tool({
        name: '',
        description: 'empty name',
        execute: async () => 'x',
      }),
    ).toThrow('requires a non-empty name');
  });

  it('stores the name on the returned function tool', () => {
    const t = tool({
      name: 'doStuff',
      description: 'd',
      execute: async () => 'x',
    });
    expect(t.name).toBe('doStuff');
  });
});

describe('ToolContext', () => {
  const makeFn = (name: string) =>
    tool({
      name,
      description: `${name} tool`,
      execute: async () => name,
    });

  it('empty() returns an empty context', () => {
    const ctx = ToolContext.empty();
    expect(ctx.functionTools).toEqual({});
    expect(ctx.providerTools).toEqual([]);
    expect(ctx.flatten()).toEqual([]);
  });

  it('indexes function tools by name and supports lookup', () => {
    const a = makeFn('a');
    const b = makeFn('b');
    const ctx = new ToolContext([a, b]);

    expect(ctx.functionTools).toEqual({ a, b });
    expect(ctx.getFunctionTool('a')).toBe(a);
    expect(ctx.getFunctionTool('b')).toBe(b);
    expect(ctx.getFunctionTool('missing')).toBeUndefined();
  });

  it('later tool with the same name overrides the earlier one', () => {
    const a1 = makeFn('a');
    const a2 = makeFn('a');
    const ctx = new ToolContext([a1, a2]);
    expect(ctx.getFunctionTool('a')).toBe(a2);
  });

  it('separates provider tools from function tools', () => {
    const fnA = makeFn('a');
    const provider = tool({ id: 'code', config: { language: 'python' } });
    const ctx = new ToolContext([fnA, provider]);

    expect(ctx.functionTools).toEqual({ a: fnA });
    expect(ctx.providerTools).toEqual([provider]);
    expect(ctx.flatten()).toEqual([fnA, provider]);
  });

  it('updateTools replaces the entire context', () => {
    const a = makeFn('a');
    const b = makeFn('b');
    const ctx = new ToolContext([a]);
    ctx.updateTools([b]);
    expect(ctx.getFunctionTool('a')).toBeUndefined();
    expect(ctx.getFunctionTool('b')).toBe(b);
  });

  it('copy() yields an independent context with the same tools', () => {
    const a = makeFn('a');
    const ctx = new ToolContext([a]);
    const dup = ctx.copy();

    expect(dup.getFunctionTool('a')).toBe(a);
    dup.updateTools([]);
    expect(ctx.getFunctionTool('a')).toBe(a);
    expect(dup.getFunctionTool('a')).toBeUndefined();
  });

  it('equals() compares function tool maps and provider lists by identity', () => {
    const a = makeFn('a');
    const b = makeFn('b');
    const c = makeFn('c');

    expect(new ToolContext([a, b]).equals(new ToolContext([a, b]))).toBe(true);
    expect(new ToolContext([a, b]).equals(new ToolContext([a]))).toBe(false);
    expect(new ToolContext([a, b]).equals(new ToolContext([a, c]))).toBe(false);
  });
});
