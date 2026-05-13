// SPDX-FileCopyrightText: 2024 LiveKit, Inc.
//
// SPDX-License-Identifier: Apache-2.0
import { describe, expect, expectTypeOf, it } from 'vitest';
import { z } from 'zod';
import * as z3 from 'zod/v3';
import * as z4 from 'zod/v4';
import type { RunContext } from '../voice/run_context.js';
import {
  type FunctionTool,
  type ProviderDefinedTool,
  type ToolCalledEvent,
  type ToolCompletedEvent,
  type ToolOptions,
  Toolset,
  tool,
} from './tool_context.js';
import { createToolOptions, oaiParams } from './utils.js';

describe('Tool Context', () => {
  describe('Toolset', () => {
    const makeTool = (name: string) =>
      tool({
        description: `${name} tool`,
        parameters: z.object({}),
        execute: async () => name,
      });

    it('flattens nested toolsets into a tool context', () => {
      const first = makeTool('first');
      const second = makeTool('second');
      const third = makeTool('third');
      const child = new Toolset({ id: 'child', tools: { second } });
      const root = new Toolset({ id: 'root', tools: { first }, toolsets: [child] });

      const ctx: Record<string, unknown> = { ...root.tools, third };

      expect(ctx.first).toBe(first);
      expect(ctx.second).toBe(second);
      expect(ctx.third).toBe(third);
    });

    it('allows duplicate names only for the same function tool instance', () => {
      const duplicate = makeTool('duplicate');
      const sameToolset = new Toolset({ id: 'same', tools: { duplicate } });

      expect(
        new Toolset({ id: 'combined', tools: { duplicate }, toolsets: [sameToolset] }).tools
          .duplicate,
      ).toBe(duplicate);

      const otherDuplicate = makeTool('duplicate');
      expect(
        () =>
          new Toolset({
            id: 'conflict',
            tools: { duplicate: otherDuplicate },
            toolsets: [sameToolset],
          }).tools,
      ).toThrow('duplicate function name: duplicate');
    });

    it('recursively sets up and closes nested toolsets', async () => {
      const events: string[] = [];

      class RecordingToolset extends Toolset {
        override async setup(): Promise<this> {
          events.push(`setup:${this.id}`);
          return await super.setup();
        }

        override async aclose(): Promise<void> {
          events.push(`close:${this.id}`);
          await super.aclose();
        }
      }

      const child = new RecordingToolset({ id: 'child' });
      const root = new RecordingToolset({ id: 'root', toolsets: [child] });

      await root.setup();
      await root.aclose();

      expect(events).toEqual(['setup:root', 'setup:child', 'close:root', 'close:child']);
    });

    it('accepts a single merged tool context', () => {
      const first = makeTool('first');
      const second = makeTool('second');
      const baseTools = { first };
      const extraTools = { second };
      const toolset = new Toolset({ id: 'merged', tools: { ...baseTools, ...extraTools } });

      expect(toolset.tools).toEqual({ first, second });
    });

    it('returns nested toolsets as key-value paired tools', () => {
      const first = makeTool('first');
      const second = makeTool('second');
      const child = new Toolset({ id: 'child', tools: { second } });
      const root = new Toolset({ id: 'root', tools: { first }, toolsets: [child] });

      expect(root.tools).toEqual({ first, second });
    });
  });

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
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        expect((simpleAction.parameters as any)._def.typeName).toBe('ZodObject');

        const result = await simpleAction.execute({}, createToolOptions('123'));
        expect(result).toBe('Action performed');
      });

      it('should support .optional() fields in tool parameters', async () => {
        const weatherTool = tool({
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

    describe('Zod v3 and v4 compatibility', () => {
      it('should work with Zod v3 schemas', async () => {
        const v3Tool = tool({
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

  it('should type toolset event payloads', () => {
    expectTypeOf<ToolCalledEvent<{ userId: string }>>().toEqualTypeOf<{
      ctx: RunContext<{ userId: string }>;
      arguments: Record<string, unknown>;
    }>();
    expectTypeOf<ToolCompletedEvent<{ userId: string }>>().toEqualTypeOf<{
      ctx: RunContext<{ userId: string }>;
      output?: { type: 'output'; value: unknown } | { type: 'error'; value: Error };
    }>();
  });
});
