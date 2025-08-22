// SPDX-FileCopyrightText: 2025 LiveKit, Inc.
//
// SPDX-License-Identifier: Apache-2.0
import type { FunctionDeclaration, Schema } from '@google/genai';
import { llm } from '@livekit/agents';
import type { JSONSchema7 } from 'json-schema';

/**
 * JSON Schema v7
 * @see https://tools.ietf.org/html/draft-handrews-json-schema-validation-01
 */
export type JSONSchema7Definition = JSONSchema7 | boolean;

/**
 * Converts JSON Schema 7 to OpenAPI Schema 3.0
 */
// Adapted from https://github.com/vercel/ai/blob/main/packages/google/src/convert-json-schema-to-openapi-schema.ts
export function convertJSONSchemaToOpenAPISchema(jsonSchema: JSONSchema7Definition): unknown {
  // parameters need to be undefined if they are empty objects:
  if (jsonSchema == null || isEmptyObjectSchema(jsonSchema)) {
    return undefined;
  }

  if (typeof jsonSchema === 'boolean') {
    return { type: 'boolean', properties: {} };
  }

  const {
    type,
    description,
    required,
    properties,
    items,
    allOf,
    anyOf,
    oneOf,
    format,
    const: constValue,
    minLength,
    enum: enumValues,
  } = jsonSchema;

  const result: Record<string, unknown> = {};

  if (description) result.description = description;
  if (required) result.required = required;
  if (format) result.format = format;

  if (constValue !== undefined) {
    result.enum = [constValue];
  }

  // Handle type
  if (type) {
    if (Array.isArray(type)) {
      if (type.includes('null')) {
        result.type = type.filter((t) => t !== 'null')[0];
        result.nullable = true;
      } else {
        result.type = type;
      }
    } else if (type === 'null') {
      result.type = 'null';
    } else {
      result.type = type;
    }
  }

  // Handle enum
  if (enumValues !== undefined) {
    result.enum = enumValues;
  }

  if (properties != null) {
    result.properties = Object.entries(properties).reduce(
      (acc, [key, value]) => {
        acc[key] = convertJSONSchemaToOpenAPISchema(value);
        return acc;
      },
      {} as Record<string, unknown>,
    );
  }

  if (items) {
    result.items = Array.isArray(items)
      ? items.map(convertJSONSchemaToOpenAPISchema)
      : convertJSONSchemaToOpenAPISchema(items);
  }

  if (allOf) {
    result.allOf = allOf.map(convertJSONSchemaToOpenAPISchema);
  }
  if (anyOf) {
    // Handle cases where anyOf includes a null type
    if (anyOf.some((schema) => typeof schema === 'object' && schema?.type === 'null')) {
      const nonNullSchemas = anyOf.filter(
        (schema) => !(typeof schema === 'object' && schema?.type === 'null'),
      );

      if (nonNullSchemas.length === 1) {
        // If there's only one non-null schema, convert it and make it nullable
        const converted = convertJSONSchemaToOpenAPISchema(
          nonNullSchemas[0] as JSONSchema7Definition,
        );
        if (typeof converted === 'object') {
          result.nullable = true;
          Object.assign(result, converted);
        }
      } else {
        // If there are multiple non-null schemas, keep them in anyOf
        result.anyOf = nonNullSchemas.map(convertJSONSchemaToOpenAPISchema);
        result.nullable = true;
      }
    } else {
      result.anyOf = anyOf.map(convertJSONSchemaToOpenAPISchema);
    }
  }
  if (oneOf) {
    result.oneOf = oneOf.map(convertJSONSchemaToOpenAPISchema);
  }

  if (minLength !== undefined) {
    result.minLength = minLength;
  }

  return result;
}

function isEmptyObjectSchema(jsonSchema: JSONSchema7Definition): boolean {
  return (
    jsonSchema != null &&
    typeof jsonSchema === 'object' &&
    jsonSchema.type === 'object' &&
    (jsonSchema.properties == null || Object.keys(jsonSchema.properties).length === 0) &&
    !jsonSchema.additionalProperties
  );
}

export function toFunctionDeclarations(toolCtx: llm.ToolContext): FunctionDeclaration[] {
  const functionDeclarations: FunctionDeclaration[] = [];

  for (const [name, tool] of Object.entries(toolCtx)) {
    const { description, parameters } = tool;
    const jsonSchema = llm.toJsonSchema(parameters, false);

    // Create a deep copy to prevent the Google GenAI library from mutating the schema
    const schemaCopy = JSON.parse(JSON.stringify(jsonSchema));

    functionDeclarations.push({
      name,
      description,
      parameters: convertJSONSchemaToOpenAPISchema(schemaCopy) as Schema,
    });
  }

  return functionDeclarations;
}
