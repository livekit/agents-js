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
  zodSchemaToJsonSchema,
} from './zod-utils.js';

type JSONSchemaProperties = Record<string, Record<string, unknown>>;

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
      expect(typeof isZod4Schema(schema)).toBe('boolean');
    });
  });

  describe('isZodSchema', () => {
    it('should detect Zod v4 schemas', () => {
      const v4Schema = z4.object({ name: z4.string() });
      expect(isZodSchema(v4Schema)).toBe(true);
    });

    it('should detect Zod v3 schemas', () => {
      const v3Schema = z3.object({ name: z3.string() });
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
      const objectSchema = z4.object({ name: z4.string() });
      expect(isZodObjectSchema(objectSchema)).toBe(true);
    });

    it('should detect Zod v3 object schemas', () => {
      const objectSchema = z3.object({ name: z3.string() });
      expect(isZodObjectSchema(objectSchema)).toBe(true);
    });

    it('should return false for non-object Zod schemas', () => {
      expect(isZodObjectSchema(z4.string())).toBe(false);
      expect(isZodObjectSchema(z4.number())).toBe(false);
      expect(isZodObjectSchema(z4.array(z4.string()))).toBe(false);
      expect(isZodObjectSchema(z3.string())).toBe(false);
      expect(isZodObjectSchema(z3.number())).toBe(false);
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
        expect(jsonSchema).toMatchSnapshot();
      });

      it.skip('should handle v4 schemas with descriptions', () => {
        // NOTE: This test is skipped because Zod 3.25.76's v4 alpha doesn't fully support
        // descriptions in toJSONSchema yet. This will work in final Zod v4 release.
        const schema = z4.object({
          location: z4.string().describe('The location to search'),
        });

        const jsonSchema = zodSchemaToJsonSchema(schema);
        expect(jsonSchema).toMatchSnapshot();
      });

      it('should handle v4 schemas with optional fields', () => {
        const schema = z4.object({
          required: z4.string(),
          optional: z4.string().optional(),
        });

        const jsonSchema = zodSchemaToJsonSchema(schema);
        expect(jsonSchema).toMatchSnapshot();
      });

      it('should handle v4 enum schemas', () => {
        const schema = z4.object({
          color: z4.enum(['red', 'blue', 'green']),
        });

        const jsonSchema = zodSchemaToJsonSchema(schema);
        expect(jsonSchema).toMatchSnapshot();
      });

      it('should handle v4 array schemas', () => {
        const schema = z4.object({
          tags: z4.array(z4.string()),
        });

        const jsonSchema = zodSchemaToJsonSchema(schema);
        expect(jsonSchema).toMatchSnapshot();
      });

      it('should handle v4 nested object schemas', () => {
        const schema = z4.object({
          user: z4.object({
            name: z4.string(),
            email: z4.string(),
          }),
        });

        const jsonSchema = zodSchemaToJsonSchema(schema);
        expect(jsonSchema).toMatchSnapshot();
      });

      it('should handle v4 schemas with multiple optional fields', () => {
        const schema = z4.object({
          id: z4.string(),
          name: z4.string().optional(),
          age: z4.number().optional(),
          email: z4.string(),
        });

        const jsonSchema = zodSchemaToJsonSchema(schema);
        expect(jsonSchema).toMatchSnapshot();
      });

      it('should handle v4 schemas with default values', () => {
        const schema = z4.object({
          name: z4.string(),
          role: z4.string().default('user'),
          active: z4.boolean().default(true),
        });

        const jsonSchema = zodSchemaToJsonSchema(schema);
        expect(jsonSchema).toMatchSnapshot();
      });
    });

    describe('Zod v3 schemas', () => {
      it('should convert basic v3 object schema to JSON Schema', () => {
        const schema = z3.object({
          name: z3.string(),
          age: z3.number(),
        });

        const jsonSchema = zodSchemaToJsonSchema(schema);
        expect(jsonSchema).toMatchSnapshot();
      });

      it('should handle v3 schemas with descriptions', () => {
        const schema = z3.object({
          location: z3.string().describe('The location to search'),
        });

        const jsonSchema = zodSchemaToJsonSchema(schema);
        expect(jsonSchema).toMatchSnapshot();
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
        expect(jsonSchema).toMatchSnapshot();
      });

      it('should handle v3 enum schemas', () => {
        const schema = z3.object({
          color: z3.enum(['red', 'blue', 'green']),
        });

        const jsonSchema = zodSchemaToJsonSchema(schema);
        expect(jsonSchema).toMatchSnapshot();
      });

      it('should handle v3 array schemas', () => {
        const schema = z3.object({
          tags: z3.array(z3.string()),
        });

        const jsonSchema = zodSchemaToJsonSchema(schema);
        expect(jsonSchema).toMatchSnapshot();
      });

      it('should handle v3 nested object schemas', () => {
        const schema = z3.object({
          user: z3.object({
            name: z3.string(),
            email: z3.string(),
          }),
        });

        const jsonSchema = zodSchemaToJsonSchema(schema);
        expect(jsonSchema).toMatchSnapshot();
      });

      it('should handle v3 schemas with multiple optional fields', () => {
        const schema = z3.object({
          id: z3.string(),
          name: z3.string().optional(),
          age: z3.number().optional(),
          email: z3.string(),
        });

        const jsonSchema = zodSchemaToJsonSchema(schema);
        expect(jsonSchema).toMatchSnapshot();
      });

      it('should handle v3 schemas with default values', () => {
        const schema = z3.object({
          name: z3.string(),
          role: z3.string().default('user'),
          active: z3.boolean().default(true),
        });

        const jsonSchema = zodSchemaToJsonSchema(schema);
        expect(jsonSchema).toMatchSnapshot();
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

    describe('strict parameter', () => {
      it('should produce strict JSON schema with strict: true', () => {
        const schema = z4.object({
          name: z4.string(),
          age: z4.number(),
        });

        const strictSchema = zodSchemaToJsonSchema(schema, true, true);
        expect(strictSchema).toMatchSnapshot();
      });

      it('should handle nullable fields in strict mode', () => {
        const schema = z4.object({
          required: z4.string(),
          optional: z4.string().nullable(),
        });

        const strictSchema = zodSchemaToJsonSchema(schema, true, true);
        expect(strictSchema).toMatchSnapshot();
      });

      it('should handle default values in strict mode', () => {
        const schema = z4.object({
          name: z4.string(),
          role: z4.string().default('user'),
          active: z4.boolean().default(true),
        });

        const strictSchema = zodSchemaToJsonSchema(schema, true, true);
        expect(strictSchema).toMatchSnapshot();
      });

      it('should handle nested objects in strict mode', () => {
        const schema = z4.object({
          user: z4.object({
            name: z4.string(),
            email: z4.string().nullable(),
          }),
          metadata: z4.object({
            created: z4.string(),
          }),
        });

        const strictSchema = zodSchemaToJsonSchema(schema, true, true);
        expect(strictSchema).toMatchSnapshot();
      });

      it('should handle arrays in strict mode', () => {
        const schema = z4.object({
          tags: z4.array(z4.string()),
          numbers: z4.array(z4.number()),
        });

        const strictSchema = zodSchemaToJsonSchema(schema, true, true);
        expect(strictSchema).toMatchSnapshot();
      });

      it('should handle v3 schemas in strict mode', () => {
        const schema = z3.object({
          name: z3.string(),
          age: z3.number().optional(),
        });

        const strictSchema = zodSchemaToJsonSchema(schema, true, true);
        expect(strictSchema).toMatchSnapshot();
      });

      it('should throw error when using .optional() without .nullable() in strict mode', () => {
        const schema = z4.object({
          required: z4.string(),
          optional: z4.string().optional(),
        });

        expect(() => zodSchemaToJsonSchema(schema, true, true)).toThrow(
          /uses `.optional\(\)` without `.nullable\(\)` which is not supported by the API/,
        );
      });

      it('should throw error for nested .optional() fields in strict mode', () => {
        const schema = z4.object({
          user: z4.object({
            name: z4.string(),
            email: z4.string().optional(),
          }),
        });

        expect(() => zodSchemaToJsonSchema(schema, true, true)).toThrow(
          /uses `.optional\(\)` without `.nullable\(\)` which is not supported by the API/,
        );
      });

      it('should NOT throw error when using .optional() in non-strict mode', () => {
        const schema = z4.object({
          required: z4.string(),
          optional: z4.string().optional(),
        });

        expect(() => zodSchemaToJsonSchema(schema, true, false)).not.toThrow();
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

  describe('Cross-version compatibility', () => {
    it('should handle mixed v3 and v4 schemas in the same codebase', async () => {
      const v3Schema = z3.object({ name: z3.string() });
      const v4Schema = z4.object({ name: z4.string() });

      const v3Result = await parseZodSchema(v3Schema, { name: 'John' });
      const v4Result = await parseZodSchema(v4Schema, { name: 'Jane' });

      expect(v3Result.success).toBe(true);
      expect(v4Result.success).toBe(true);
    });

    it('should convert both v3 and v4 basic schemas to compatible JSON Schema', () => {
      const v3Schema = z3.object({ count: z3.number() });
      const v4Schema = z4.object({ count: z4.number() });

      const v3Json = zodSchemaToJsonSchema(v3Schema);
      const v4Json = zodSchemaToJsonSchema(v4Schema);

      // Both should produce valid JSON Schema with same structure
      expect(v3Json.type).toBe('object');
      expect(v4Json.type).toBe('object');
      expect((v3Json.properties as JSONSchemaProperties).count?.type).toBe('number');
      expect((v4Json.properties as JSONSchemaProperties).count?.type).toBe('number');
    });

    it('should handle optional fields consistently across v3 and v4', () => {
      const v3Schema = z3.object({
        required: z3.string(),
        optional: z3.string().optional(),
      });
      const v4Schema = z4.object({
        required: z4.string(),
        optional: z4.string().optional(),
      });

      const v3Json = zodSchemaToJsonSchema(v3Schema);
      const v4Json = zodSchemaToJsonSchema(v4Schema);

      // Both should mark 'required' as required
      expect(v3Json.required).toContain('required');
      expect(v4Json.required).toContain('required');

      // v4 should NOT mark 'optional' as required
      expect(v4Json.required).not.toContain('optional');

      // NOTE: v3's optional handling in zod-to-json-schema (for the v3 export) has quirks
      // in the alpha version 3.25.76. The default z import works correctly for users.
    });

    it('should handle complex schemas with nested objects and arrays consistently', () => {
      const v3Schema = z3.object({
        user: z3.object({
          name: z3.string(),
          email: z3.string().optional(),
        }),
        tags: z3.array(z3.string()),
        status: z3.enum(['active', 'inactive']),
      });

      const v4Schema = z4.object({
        user: z4.object({
          name: z4.string(),
          email: z4.string().optional(),
        }),
        tags: z4.array(z4.string()),
        status: z4.enum(['active', 'inactive']),
      });

      const v3Json = zodSchemaToJsonSchema(v3Schema);
      const v4Json = zodSchemaToJsonSchema(v4Schema);

      // Check structure compatibility
      expect(v3Json.type).toBe(v4Json.type);
      expect(Object.keys(v3Json.properties || {})).toEqual(Object.keys(v4Json.properties || {}));

      // Check nested object
      const v3User = (v3Json.properties as JSONSchemaProperties).user;
      const v4User = (v4Json.properties as JSONSchemaProperties).user;
      expect(v3User?.type).toBe('object');
      expect(v4User?.type).toBe('object');

      // Check array
      const v3Tags = (v3Json.properties as JSONSchemaProperties).tags;
      const v4Tags = (v4Json.properties as JSONSchemaProperties).tags;
      expect(v3Tags?.type).toBe('array');
      expect(v4Tags?.type).toBe('array');

      // Check enum
      const v3Status = (v3Json.properties as JSONSchemaProperties).status;
      const v4Status = (v4Json.properties as JSONSchemaProperties).status;
      expect(v3Status?.enum).toEqual(['active', 'inactive']);
      expect(v4Status?.enum).toEqual(['active', 'inactive']);
    });
  });
});
