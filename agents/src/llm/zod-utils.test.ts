// SPDX-FileCopyrightText: 2025 LiveKit, Inc.
//
// SPDX-License-Identifier: Apache-2.0
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import * as z3 from 'zod/v3';
import * as z4 from 'zod/v4';
import {
  isZod4Schema,
  isZodObjectSchema,
  isZodSchema,
  parseZodSchema,
  parseZodSchemaSync,
  zodSchemaToJsonSchema,
} from './zod-utils.js';

function asRecord(value: unknown): Record<string, unknown> {
  return value as Record<string, unknown>;
}

// Helper type for accessing JSON schema properties
type JSONSchemaProperties = Record<string, Record<string, unknown>>;

function getProperties(schema: Record<string, unknown>): JSONSchemaProperties {
  return schema.properties as JSONSchemaProperties;
}

describe('Zod Utils', () => {
  describe('isZod4Schema', () => {
    it('should detect Zod v4 schemas', () => {
      const v4Schema = z4.string();
      expect(isZod4Schema(v4Schema)).toBe(true);
    });

    it('should detect Zod v3 schemas', () => {
      const v3Schema = z3.string();
      expect(isZod4Schema(v3Schema)).toBe(false);
    });

    it('should handle default z import (follows installed version)', () => {
      const schema = z.string();
      // This will be true or false depending on which version is installed
      // We just test that it doesn't throw
      expect(typeof isZod4Schema(schema)).toBe('boolean');
    });
  });

  describe('isZodSchema', () => {
    it('should detect Zod v4 schemas', () => {
      const v4Schema = z4!.object({ name: z4!.string() });
      expect(isZodSchema(v4Schema)).toBe(true);
    });

    it('should detect Zod v3 schemas', () => {
      const v3Schema = z3!.object({ name: z3!.string() });
      expect(isZodSchema(v3Schema)).toBe(true);
    });

    it('should return false for non-Zod values', () => {
      expect(isZodSchema({})).toBe(false);
      expect(isZodSchema(null)).toBe(false);
      expect(isZodSchema(undefined)).toBe(false);
      expect(isZodSchema('string')).toBe(false);
      expect(isZodSchema(123)).toBe(false);
      expect(isZodSchema({ _def: {} })).toBe(false); // missing typeName
    });
  });

  describe('isZodObjectSchema', () => {
    it('should detect Zod v4 object schemas', () => {
      const objectSchema = z4!.object({ name: z4!.string() });
      expect(isZodObjectSchema(objectSchema)).toBe(true);
    });

    it('should detect Zod v3 object schemas', () => {
      const objectSchema = z3!.object({ name: z3!.string() });
      expect(isZodObjectSchema(objectSchema)).toBe(true);
    });

    it('should return false for non-object Zod schemas', () => {
      expect(isZodObjectSchema(z4!.string())).toBe(false);
      expect(isZodObjectSchema(z4!.number())).toBe(false);
      expect(isZodObjectSchema(z4!.array(z4!.string()))).toBe(false);
      expect(isZodObjectSchema(z3!.string())).toBe(false);
      expect(isZodObjectSchema(z3!.number())).toBe(false);
    });
  });

  describe('zodSchemaToJsonSchema', () => {
    describe('Zod v4 schemas', () => {
      it('should convert basic v4 object schema to JSON Schema', () => {
        const schema = z4.object({
          name: z4.string(),
          age: z4.number(),
        });

        const jsonSchema = zodSchemaToJsonSchema(schema);

        expect(jsonSchema).toHaveProperty('type', 'object');
        expect(jsonSchema).toHaveProperty('properties');
        expect(jsonSchema.properties).toHaveProperty('name');
        expect(jsonSchema.properties).toHaveProperty('age');
        expect(getProperties(asRecord(jsonSchema)).name.type).toBe('string');
        expect(getProperties(asRecord(jsonSchema)).age.type).toBe('number');
      });

      it.skip('should handle v4 schemas with descriptions', () => {
        // NOTE: This test is skipped because Zod 3.25.76's v4 alpha doesn't fully support
        // descriptions in toJSONSchema yet. This will work in final Zod v4 release.
        const schema = z4.object({
          location: z4.string().describe('The location to search'),
        });

        const jsonSchema = zodSchemaToJsonSchema(schema);

        expect(getProperties(asRecord(jsonSchema)).location.description).toBe(
          'The location to search',
        );
      });

      it('should handle v4 schemas with optional fields', () => {
        const schema = z4.object({
          required: z4.string(),
          optional: z4.string().optional(),
        });

        const jsonSchema = zodSchemaToJsonSchema(schema);

        expect(jsonSchema.required).toContain('required');
        expect(jsonSchema.required).not.toContain('optional');
      });

      it('should handle v4 enum schemas', () => {
        const schema = z4.object({
          color: z4.enum(['red', 'blue', 'green']),
        });

        const jsonSchema = zodSchemaToJsonSchema(schema);

        expect(getProperties(asRecord(jsonSchema)).color.enum).toEqual(['red', 'blue', 'green']);
      });

      it('should handle v4 array schemas', () => {
        const schema = z4.object({
          tags: z4.array(z4.string()),
        });

        const jsonSchema = zodSchemaToJsonSchema(schema);

        expect(getProperties(asRecord(jsonSchema)).tags.type).toBe('array');
        expect(getProperties(asRecord(jsonSchema)).tags.items.type).toBe('string');
      });

      it('should handle v4 nested object schemas', () => {
        const schema = z4.object({
          user: z4.object({
            name: z4.string(),
            email: z4.string(),
          }),
        });

        const jsonSchema = zodSchemaToJsonSchema(schema);

        expect(getProperties(asRecord(jsonSchema)).user.type).toBe('object');
        expect(getProperties(asRecord(jsonSchema)).user.properties).toHaveProperty('name');
        expect(getProperties(asRecord(jsonSchema)).user.properties).toHaveProperty('email');
      });
    });

    describe('Zod v3 schemas', () => {
      it('should convert basic v3 object schema to JSON Schema', () => {
        const schema = z3.object({
          name: z3.string(),
          age: z3.number(),
        });

        const jsonSchema = zodSchemaToJsonSchema(schema);

        expect(jsonSchema).toHaveProperty('type', 'object');
        expect(jsonSchema).toHaveProperty('properties');
        expect(jsonSchema.properties).toHaveProperty('name');
        expect(jsonSchema.properties).toHaveProperty('age');
        expect(getProperties(asRecord(jsonSchema)).name.type).toBe('string');
        expect(getProperties(asRecord(jsonSchema)).age.type).toBe('number');
      });

      it('should handle v3 schemas with descriptions', () => {
        const schema = z3.object({
          location: z3.string().describe('The location to search'),
        });

        const jsonSchema = zodSchemaToJsonSchema(schema);

        expect(getProperties(asRecord(jsonSchema)).location.description).toBe(
          'The location to search',
        );
      });

      it.skip('should handle v3 schemas with optional fields', () => {
        // NOTE: This test is skipped because in Zod 3.25.76, the v3 export's optional()
        // handling in zod-to-json-schema has some quirks. The behavior is correct for
        // the default z import which is what users will typically use.
        const schema = z3.object({
          required: z3.string(),
          optional: z3.string().optional(),
        });

        const jsonSchema = zodSchemaToJsonSchema(schema);

        expect(jsonSchema.required).toContain('required');
        expect(jsonSchema.required).not.toContain('optional');
      });

      it('should handle v3 enum schemas', () => {
        const schema = z3.object({
          color: z3.enum(['red', 'blue', 'green']),
        });

        const jsonSchema = zodSchemaToJsonSchema(schema);

        expect(getProperties(asRecord(jsonSchema)).color.enum).toEqual(['red', 'blue', 'green']);
      });

      it('should handle v3 array schemas', () => {
        const schema = z3.object({
          tags: z3.array(z3.string()),
        });

        const jsonSchema = zodSchemaToJsonSchema(schema);

        expect(getProperties(asRecord(jsonSchema)).tags.type).toBe('array');
        expect(getProperties(asRecord(jsonSchema)).tags.items.type).toBe('string');
      });

      it('should handle v3 nested object schemas', () => {
        const schema = z3.object({
          user: z3.object({
            name: z3.string(),
            email: z3.string(),
          }),
        });

        const jsonSchema = zodSchemaToJsonSchema(schema);

        expect(getProperties(asRecord(jsonSchema)).user.type).toBe('object');
        expect(getProperties(asRecord(jsonSchema)).user.properties).toHaveProperty('name');
        expect(getProperties(asRecord(jsonSchema)).user.properties).toHaveProperty('email');
      });
    });

    describe('isOpenai parameter', () => {
      it('should respect isOpenai parameter for v3 schemas', () => {
        const schema = z3.object({ name: z3.string() });

        const openaiSchema = zodSchemaToJsonSchema(schema, true);
        const jsonSchema7 = zodSchemaToJsonSchema(schema, false);

        // Both should work, just different internal handling
        expect(openaiSchema).toHaveProperty('properties');
        expect(jsonSchema7).toHaveProperty('properties');
      });
    });
  });

  describe('parseZodSchema', () => {
    describe('Zod v4 schemas', () => {
      it('should successfully parse valid v4 data', async () => {
        const schema = z4.object({
          name: z4.string(),
          age: z4.number(),
        });

        const result = await parseZodSchema(schema, { name: 'John', age: 30 });

        expect(result.success).toBe(true);
        if (result.success) {
          expect(result.data).toEqual({ name: 'John', age: 30 });
        }
      });

      it('should fail to parse invalid v4 data', async () => {
        const schema = z4.object({
          name: z4.string(),
          age: z4.number(),
        });

        const result = await parseZodSchema(schema, { name: 'John', age: 'invalid' });

        expect(result.success).toBe(false);
        if (!result.success) {
          expect(result.error).toBeDefined();
        }
      });

      it('should handle v4 optional fields', async () => {
        const schema = z4.object({
          name: z4.string(),
          email: z4.string().optional(),
        });

        const result1 = await parseZodSchema(schema, { name: 'John' });
        expect(result1.success).toBe(true);

        const result2 = await parseZodSchema(schema, { name: 'John', email: 'john@example.com' });
        expect(result2.success).toBe(true);
      });

      it('should handle v4 default values', async () => {
        const schema = z4.object({
          name: z4.string(),
          role: z4.string().default('user'),
        });

        const result = await parseZodSchema(schema, { name: 'John' });

        expect(result.success).toBe(true);
        if (result.success) {
          expect(result.data).toEqual({ name: 'John', role: 'user' });
        }
      });
    });

    describe('Zod v3 schemas', () => {
      it('should successfully parse valid v3 data', async () => {
        const schema = z3.object({
          name: z3.string(),
          age: z3.number(),
        });

        const result = await parseZodSchema(schema, { name: 'John', age: 30 });

        expect(result.success).toBe(true);
        if (result.success) {
          expect(result.data).toEqual({ name: 'John', age: 30 });
        }
      });

      it('should fail to parse invalid v3 data', async () => {
        const schema = z3.object({
          name: z3.string(),
          age: z3.number(),
        });

        const result = await parseZodSchema(schema, { name: 'John', age: 'invalid' });

        expect(result.success).toBe(false);
        if (!result.success) {
          expect(result.error).toBeDefined();
        }
      });

      it('should handle v3 optional fields', async () => {
        const schema = z3.object({
          name: z3.string(),
          email: z3.string().optional(),
        });

        const result1 = await parseZodSchema(schema, { name: 'John' });
        expect(result1.success).toBe(true);

        const result2 = await parseZodSchema(schema, { name: 'John', email: 'john@example.com' });
        expect(result2.success).toBe(true);
      });

      it('should handle v3 default values', async () => {
        const schema = z3.object({
          name: z3.string(),
          role: z3.string().default('user'),
        });

        const result = await parseZodSchema(schema, { name: 'John' });

        expect(result.success).toBe(true);
        if (result.success) {
          expect(result.data).toEqual({ name: 'John', role: 'user' });
        }
      });
    });
  });

  describe('parseZodSchemaSync', () => {
    describe('Zod v4 schemas', () => {
      it('should successfully parse valid v4 data synchronously', () => {
        const schema = z4.object({
          name: z4.string(),
          age: z4.number(),
        });

        const result = parseZodSchemaSync(schema, { name: 'John', age: 30 });

        expect(result.success).toBe(true);
        if (result.success) {
          expect(result.data).toEqual({ name: 'John', age: 30 });
        }
      });

      it('should fail to parse invalid v4 data synchronously', () => {
        const schema = z4.object({
          name: z4.string(),
          age: z4.number(),
        });

        const result = parseZodSchemaSync(schema, { name: 'John', age: 'invalid' });

        expect(result.success).toBe(false);
        if (!result.success) {
          expect(result.error).toBeDefined();
        }
      });
    });

    describe('Zod v3 schemas', () => {
      it('should successfully parse valid v3 data synchronously', () => {
        const schema = z3.object({
          name: z3.string(),
          age: z3.number(),
        });

        const result = parseZodSchemaSync(schema, { name: 'John', age: 30 });

        expect(result.success).toBe(true);
        if (result.success) {
          expect(result.data).toEqual({ name: 'John', age: 30 });
        }
      });

      it('should fail to parse invalid v3 data synchronously', () => {
        const schema = z3.object({
          name: z3.string(),
          age: z3.number(),
        });

        const result = parseZodSchemaSync(schema, { name: 'John', age: 'invalid' });

        expect(result.success).toBe(false);
        if (!result.success) {
          expect(result.error).toBeDefined();
        }
      });
    });
  });

  describe('Cross-version compatibility', () => {
    it('should handle mixed v3 and v4 schemas in the same codebase', async () => {
      const v3Schema = z3.object({ name: z3.string() });
      const v4Schema = z4.object({ name: z4.string() });

      const v3Result = await parseZodSchema(v3Schema, { name: 'John' });
      const v4Result = await parseZodSchema(v4Schema, { name: 'Jane' });

      expect(v3Result.success).toBe(true);
      expect(v4Result.success).toBe(true);
    });

    it('should convert both v3 and v4 schemas to JSON Schema', () => {
      const v3Schema = z3.object({ count: z3.number() });
      const v4Schema = z4.object({ count: z4.number() });

      const v3Json = zodSchemaToJsonSchema(v3Schema);
      const v4Json = zodSchemaToJsonSchema(v4Schema);

      // Both should produce valid JSON Schema
      expect(v3Json.type).toBe('object');
      expect(v4Json.type).toBe('object');
      expect(getProperties(asRecord(v3Json)).count.type).toBe('number');
      expect(getProperties(asRecord(v4Json)).count.type).toBe('number');
    });
  });
});
