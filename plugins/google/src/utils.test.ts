// SPDX-FileCopyrightText: 2026 LiveKit, Inc.
//
// SPDX-License-Identifier: Apache-2.0
import type { Schema } from '@google/genai';
import { llm } from '@livekit/agents';
import type { JSONSchema7 } from 'json-schema';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { toFunctionDeclarations, toToolsConfig } from './utils.js';

const saveContact = llm.tool({
  name: 'save_contact',
  description: 'Save the contact fields gathered in the conversation (free-form keys).',
  parameters: z.object({ fields: z.record(z.string(), z.string()) }),
  execute: async () => {},
});

const ping = llm.tool({
  name: 'ping',
  description: 'A tool without parameters.',
  execute: async () => {},
});

function schemaProperty(schema: unknown, name: string): JSONSchema7 {
  const property = ((schema as JSONSchema7).properties as Record<string, JSONSchema7>)[name];
  if (property === undefined) {
    throw new Error(`Missing schema property: ${name}`);
  }
  return property;
}

function singleDeclaration(toolCtx: llm.ToolContext, useParametersJsonSchema = true) {
  const [declaration] = toFunctionDeclarations(toolCtx, useParametersJsonSchema);
  if (declaration === undefined) {
    throw new Error('Missing function declaration');
  }
  return declaration;
}

describe('Gemini function declarations', () => {
  it('uses parametersJsonSchema on the text API', () => {
    const declaration = singleDeclaration(new llm.ToolContext([saveContact]));

    expect(declaration.parameters).toBeUndefined();
    const schema = declaration.parametersJsonSchema as JSONSchema7;
    expect(schemaProperty(schema, 'fields')).toMatchObject({
      type: 'object',
      additionalProperties: { type: 'string' },
    });
    expect(schema.required).toEqual(['fields']);
  });

  it('uses legacy parameters on the Live API', () => {
    const declaration = singleDeclaration(new llm.ToolContext([saveContact]), false);

    expect(declaration.parametersJsonSchema).toBeUndefined();
    expect(declaration.parameters).toEqual({
      type: 'object',
      properties: { fields: { type: 'object' } },
      required: ['fields'],
      propertyOrdering: ['fields'],
    });
  });

  it('orders Live API parameters as declared, nested objects included', () => {
    const decide = llm.tool({
      name: 'decide',
      description: 'Reason first, then answer.',
      parameters: z.object({
        reasoning: z.string(),
        answer: z.enum(['a', 'b']),
        details: z.object({ zeta: z.string(), alpha: z.string() }),
      }),
      execute: async () => {},
    });
    const declaration = singleDeclaration(new llm.ToolContext([decide]), false);

    const schema = declaration.parameters as Schema;
    expect(schema.propertyOrdering).toEqual(['reasoning', 'answer', 'details']);
    expect(schema.properties?.details?.propertyOrdering).toEqual(['zeta', 'alpha']);
  });

  it('omits the schema for a function tool without parameters', () => {
    const toolCtx = new llm.ToolContext([ping]);
    const textDeclaration = singleDeclaration(toolCtx);
    const liveDeclaration = singleDeclaration(toolCtx, false);

    expect(textDeclaration.parametersJsonSchema).toBeUndefined();
    expect(textDeclaration.parameters).toBeUndefined();
    expect(liveDeclaration.parameters).toBeUndefined();
    expect(liveDeclaration.parametersJsonSchema).toBeUndefined();
  });

  it('matches generated and raw free-form object schemas on the text API', () => {
    const raw = llm.tool({
      name: 'save_contact',
      description: 'Save the contact fields gathered in the conversation (free-form keys).',
      parameters: {
        type: 'object',
        properties: {
          fields: { type: 'object', additionalProperties: { type: 'string' } },
        },
        required: ['fields'],
      },
      execute: async () => {},
    });
    const rawDeclaration = singleDeclaration(new llm.ToolContext([raw]));
    const generatedDeclaration = singleDeclaration(new llm.ToolContext([saveContact]));

    const rawFields = schemaProperty(rawDeclaration.parametersJsonSchema, 'fields');
    const generatedSchema = generatedDeclaration.parametersJsonSchema as JSONSchema7;
    const generatedFields = schemaProperty(generatedSchema, 'fields');
    expect(generatedFields.additionalProperties).toEqual(rawFields.additionalProperties);
    expect(generatedSchema.required).toEqual(['fields']);
  });

  it('emits parametersJsonSchema from the tools config', () => {
    const [tools] = toToolsConfig({ toolCtx: new llm.ToolContext([saveContact]) });

    const [declaration] = tools?.[0]?.functionDeclarations ?? [];
    expect(declaration?.parameters).toBeUndefined();
    const fields = schemaProperty(declaration?.parametersJsonSchema, 'fields');
    expect(fields.additionalProperties).toEqual({ type: 'string' });
  });

  it('names a tool whose schema Gemini rejects', () => {
    const bad = llm.tool({
      name: 'bad',
      description: 'd',
      parameters: {
        type: 'object',
        properties: { a: { type: 'string', minLength: 'many' } },
      } as never,
      execute: async () => {},
    });

    expect(() =>
      toToolsConfig({
        toolCtx: new llm.ToolContext([bad]),
        useParametersJsonSchema: false,
      }),
    ).toThrow('tool bad has a schema Gemini rejected');
  });
});
