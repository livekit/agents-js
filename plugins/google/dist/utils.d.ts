import type { FunctionDeclaration } from '@google/genai';
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
export declare function convertJSONSchemaToOpenAPISchema(jsonSchema: JSONSchema7Definition): unknown;
export declare function toFunctionDeclarations(toolCtx: llm.ToolContext): FunctionDeclaration[];
//# sourceMappingURL=utils.d.ts.map