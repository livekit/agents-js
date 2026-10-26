// SPDX-FileCopyrightText: 2025 LiveKit, Inc.
//
// SPDX-License-Identifier: Apache-2.0
import type { JSONSchema7 } from 'json-schema';
import { toStrictJsonSchema } from 'openai/lib/transform';
import { zodToJsonSchema as zodToJsonSchemaV3 } from 'zod-to-json-schema';
import type * as z3 from 'zod/v3';
import * as z4 from 'zod/v4';

/**
 * Result type from Zod schema parsing.
 */
export type ZodParseResult<T = unknown> =
  | { success: true; data: T }
  | { success: false; error: unknown };

/**
 * Type definition for Zod schemas that works with both v3 and v4.
 * Uses a union type of both Zod v3 and v4 schema types.
 *
 * Adapted from Vercel AI SDK's zodSchema function signature.
 * Source: https://github.com/vercel/ai/blob/main/packages/provider-utils/src/schema.ts#L278-L281
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type ZodSchema = z4.core.$ZodType<any, any> | z3.Schema<any, z3.ZodTypeDef, any>;

/**
 * Detects if a schema is a Zod v4 schema.
 * Zod v4 schemas have a `_zod` property that v3 schemas don't have.
 *
 * @param schema - The schema to check
 * @returns True if the schema is a Zod v4 schema
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any -- Required to match Zod v4's type signature
export function isZod4Schema(schema: ZodSchema): schema is z4.core.$ZodType<any, any> {
  // https://zod.dev/library-authors?id=how-to-support-zod-3-and-zod-4-simultaneously
  return '_zod' in schema;
}

/**
 * Checks if a value is a Zod schema (either v3 or v4).
 *
 * @param value - The value to check
 * @returns True if the value is a Zod schema
 */
export function isZodSchema(value: unknown): value is ZodSchema {
  if (typeof value !== 'object' || value === null) {
    return false;
  }

  // Check for v4 schema (_zod property)
  if ('_zod' in value) {
    return true;
  }

  // Check for v3 schema (_def property with typeName)
  if ('_def' in value && typeof value._def === 'object' && value._def !== null) {
    const def = value._def as Record<string, unknown>;
    if ('typeName' in def) {
      return true;
    }
  }

  return false;
}

/**
 * Checks if a Zod schema is an object schema.
 *
 * @param schema - The schema to check
 * @returns True if the schema is an object schema
 */
export function isZodObjectSchema(schema: ZodSchema): boolean {
  // Need to access internal Zod properties to check schema type
  const schemaWithInternals = schema as {
    _def?: { type?: string; typeName?: string };
    _zod?: { traits?: Set<string> };
  };

  // Check for v4 schema first
  if (isZod4Schema(schema)) {
    // v4 uses _def.type and _zod.traits
    return (
      schemaWithInternals._def?.type === 'object' ||
      schemaWithInternals._zod?.traits?.has('ZodObject') ||
      false
    );
  }

  // v3 uses _def.typeName
  return schemaWithInternals._def?.typeName === 'ZodObject';
}

/**
 * Converts a Zod schema to JSON Schema format.
 * Handles both Zod v3 and v4 schemas automatically.
 *
 * Adapted from Vercel AI SDK's zod3Schema and zod4Schema functions.
 * Source: https://github.com/vercel/ai/blob/main/packages/provider-utils/src/schema.ts#L237-L269
 *
 * @param schema - The Zod schema to convert
 * @param isOpenai - Whether to use OpenAI-specific formatting (default: true)
 * @returns A JSON Schema representation of the Zod schema
 */
export function zodSchemaToJsonSchema(
  schema: ZodSchema,
  isOpenai: boolean = true,
  strict: boolean = false,
): JSONSchema7 {
  let result: JSONSchema7;

  if (isZod4Schema(schema)) {
    // Zod v4 has native toJSONSchema support
    // Configuration adapted from Vercel AI SDK to support OpenAPI conversion for Google
    // Source: https://github.com/vercel/ai/blob/main/packages/provider-utils/src/schema.ts#L255-L258
    result = z4.toJSONSchema(schema, {
      target: 'draft-7',
      io: 'output',
      reused: 'inline', // Don't use references by default (to support openapi conversion for google)
    }) as JSONSchema7;
  } else {
    // Zod v3 requires the zod-to-json-schema library
    // Configuration adapted from Vercel AI SDK
    // $refStrategy: 'none' is equivalent to v4's reused: 'inline'
    result = zodToJsonSchemaV3(schema, {
      target: isOpenai ? 'openAi' : 'jsonSchema7',
      $refStrategy: 'none', // Don't use references by default (to support openapi conversion for google)
    }) as JSONSchema7;
  }

  if (!strict) {
    return result;
  }

  const strictSchema = toStrictJsonSchema(result) as JSONSchema7;
  applyNullSentinelForDefaults(strictSchema);
  return strictSchema;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Descends only through positions that hold subschemas, so a user-declared property named
 * `default` (or `items`, `not`, ...) is never treated as a schema keyword.
 *
 * `unionAllowsNull` marks a variant whose enclosing union already advertises a null branch;
 * such a variant drops `default` without widening, since the sibling branch is the sentinel.
 */
function applyNullSentinelForDefaults(jsonSchema: unknown, unionAllowsNull: boolean = false): void {
  if (!isPlainObject(jsonSchema)) {
    return;
  }

  for (const mapKey of ['$defs', 'definitions', 'properties'] as const) {
    const subschemas = jsonSchema[mapKey];
    if (isPlainObject(subschemas)) {
      for (const subschema of Object.values(subschemas)) {
        applyNullSentinelForDefaults(subschema);
      }
    }
  }

  for (const key of ['items', 'prefixItems', 'additionalProperties', 'not'] as const) {
    const subschema = jsonSchema[key];
    if (Array.isArray(subschema)) {
      for (const item of subschema) {
        applyNullSentinelForDefaults(item);
      }
    } else {
      applyNullSentinelForDefaults(subschema);
    }
  }

  for (const unionKey of ['anyOf', 'oneOf', 'allOf'] as const) {
    const variants = jsonSchema[unionKey];
    if (!Array.isArray(variants)) {
      continue;
    }
    const hasNullVariant =
      unionKey !== 'allOf' &&
      variants.some((variant) => isPlainObject(variant) && variant.type === 'null');
    for (const variant of variants) {
      applyNullSentinelForDefaults(variant, hasNullVariant);
    }
  }

  if (!Object.prototype.hasOwnProperty.call(jsonSchema, 'default')) {
    return;
  }

  delete jsonSchema.default;
  if (!unionAllowsNull) {
    addNullSentinel(jsonSchema);
  }
}

function addNullSentinel(jsonSchema: Record<string, unknown>): void {
  const typ = jsonSchema.type;
  if (typ === 'null' || (Array.isArray(typ) && typ.includes('null'))) {
    return;
  }

  // A const has exactly one legal value, so it must remain non-nullable. Once strict schema
  // conversion removes `discriminator`, these const tags are what distinguish union variants.
  if ('const' in jsonSchema) {
    return;
  }

  for (const unionKey of ['anyOf', 'oneOf'] as const) {
    const variants = jsonSchema[unionKey];
    if (Array.isArray(variants)) {
      if (!variants.some((variant) => isPlainObject(variant) && variant.type === 'null')) {
        variants.push({ type: 'null' });
      }
      return;
    }
  }

  const hasEnum = 'enum' in jsonSchema;
  if (typeof typ === 'string' && !hasEnum) {
    jsonSchema.type = [typ, 'null'];
    return;
  }
  if (Array.isArray(typ) && !hasEnum) {
    jsonSchema.type = [...typ, 'null'];
    return;
  }

  const inner = { ...jsonSchema };
  if (Object.keys(inner).length === 0) {
    return;
  }

  for (const key of Object.keys(jsonSchema)) {
    delete jsonSchema[key];
  }

  if ('$ref' in inner && Object.keys(inner).length > 1) {
    Object.assign(jsonSchema, inner);
    const ref = jsonSchema.$ref;
    delete jsonSchema.$ref;
    jsonSchema.anyOf = [{ $ref: ref }, { type: 'null' }];
  } else {
    jsonSchema.anyOf = [inner, { type: 'null' }];
  }
}

function resolveRef(root: Record<string, unknown>, ref: string): unknown {
  if (!ref.startsWith('#/')) {
    throw new Error(`Unexpected $ref format ${ref}; does not start with #/`);
  }

  return ref
    .slice(2)
    .split('/')
    .reduce<unknown>((current, part) => {
      if (!isPlainObject(current)) {
        throw new Error(`Encountered non-object while resolving ${ref}`);
      }
      const key = part.replace(/~1/g, '/').replace(/~0/g, '~');
      return current[key];
    }, root);
}

export function jsonSchemaAllowsNull(
  schema: Record<string, unknown>,
  root: Record<string, unknown>,
  seenRefs: Set<string> = new Set(),
): boolean {
  const ref = schema.$ref;
  if (typeof ref === 'string') {
    if (seenRefs.has(ref)) {
      return false;
    }
    const resolved = resolveRef(root, ref);
    if (
      isPlainObject(resolved) &&
      !jsonSchemaAllowsNull(resolved, root, new Set([...seenRefs, ref]))
    ) {
      return false;
    }
  }

  const typ = schema.type;
  if (typeof typ === 'string' && typ !== 'null') {
    return false;
  }
  if (Array.isArray(typ) && !typ.includes('null')) {
    return false;
  }

  if ('const' in schema && schema.const !== null) {
    return false;
  }
  const enumValues = schema.enum;
  if (Array.isArray(enumValues) && !enumValues.includes(null)) {
    return false;
  }

  const allOf = schema.allOf;
  if (
    Array.isArray(allOf) &&
    !allOf.every(
      (variant) => !isPlainObject(variant) || jsonSchemaAllowsNull(variant, root, seenRefs),
    )
  ) {
    return false;
  }

  for (const unionKey of ['anyOf', 'oneOf'] as const) {
    const variants = schema[unionKey];
    if (
      Array.isArray(variants) &&
      !variants.some(
        (variant) => isPlainObject(variant) && jsonSchemaAllowsNull(variant, root, seenRefs),
      )
    ) {
      return false;
    }
  }

  return true;
}

/**
 * Parses a value against a Zod schema.
 * Handles both Zod v3 and v4 parse APIs automatically.
 *
 * @param schema - The Zod schema to parse against
 * @param value - The value to parse
 * @returns A promise that resolves to the parse result
 */
export async function parseZodSchema<T = unknown>(
  schema: ZodSchema,
  value: unknown,
): Promise<ZodParseResult<T>> {
  if (isZod4Schema(schema)) {
    const result = await z4.safeParseAsync(schema, value);
    return result as ZodParseResult<T>;
  } else {
    const result = await schema.safeParseAsync(value);
    return result as ZodParseResult<T>;
  }
}
