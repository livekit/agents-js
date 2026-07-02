// SPDX-FileCopyrightText: 2025 LiveKit, Inc.
//
// SPDX-License-Identifier: Apache-2.0
import { z } from 'zod';

// ============================================================================
// Cartesia WebSocket API Schemas
// Ref: https://docs.cartesia.ai/api-reference/tts/websocket
// ============================================================================

/** Word timestamps schema - contains timing info for each word */
export const cartesiaWordTimestampsSchema = z.object({
  words: z.array(z.string()),
  start: z.array(z.number()),
  end: z.array(z.number()),
});

/** Audio chunk message - type: "chunk" with base64-encoded audio data */
export const cartesiaChunkMessageSchema = z.object({
  type: z.literal('chunk'),
  data: z.string(),
  done: z.boolean(),
  status_code: z.number(),
  step_time: z.number(),
  context_id: z.string(),
});

/** Word timestamps message - type: "timestamps" with word timing data */
export const cartesiaTimestampsMessageSchema = z.object({
  type: z.literal('timestamps'),
  done: z.boolean(),
  status_code: z.number(),
  context_id: z.string(),
  word_timestamps: cartesiaWordTimestampsSchema,
});

/** Done message - type: "done" indicates completion */
export const cartesiaDoneMessageSchema = z.object({
  type: z.literal('done'),
  done: z.boolean(),
  status_code: z.number(),
  context_id: z.string(),
});

/** Flush done message - type: "flush_done" indicates flush completion */
export const cartesiaFlushDoneMessageSchema = z.object({
  type: z.literal('flush_done'),
  done: z.boolean(),
  flush_done: z.boolean(),
  flush_id: z.number(),
  status_code: z.number(),
  context_id: z.string(),
});

/** Error message - has error field */
export const cartesiaErrorMessageSchema = z.object({
  type: z.string(),
  done: z.boolean(),
  error: z.string(),
  status_code: z.number(),
  context_id: z.string(),
});

/** Union of all possible Cartesia server messages using discriminated union on 'type' */
export const cartesiaServerMessageSchema = z.discriminatedUnion('type', [
  cartesiaChunkMessageSchema,
  cartesiaTimestampsMessageSchema,
  cartesiaDoneMessageSchema,
  cartesiaFlushDoneMessageSchema,
]);

// Fallback schema for error messages (can't be in discriminated union due to dynamic type)
export const cartesiaMessageSchema = z.union([
  cartesiaServerMessageSchema,
  cartesiaErrorMessageSchema,
]);

// ============================================================================
// Type exports from Zod schemas
// ============================================================================

export type CartesiaWordTimestamps = z.infer<typeof cartesiaWordTimestampsSchema>;
export type CartesiaChunkMessage = z.infer<typeof cartesiaChunkMessageSchema>;
export type CartesiaTimestampsMessage = z.infer<typeof cartesiaTimestampsMessageSchema>;
export type CartesiaDoneMessage = z.infer<typeof cartesiaDoneMessageSchema>;
export type CartesiaFlushDoneMessage = z.infer<typeof cartesiaFlushDoneMessageSchema>;
export type CartesiaErrorMessage = z.infer<typeof cartesiaErrorMessageSchema>;
export type CartesiaServerMessage = z.infer<typeof cartesiaMessageSchema>;

// ============================================================================
// Helper type guards for message discrimination
// ============================================================================

export function isChunkMessage(msg: CartesiaServerMessage): msg is CartesiaChunkMessage {
  return 'type' in msg && msg.type === 'chunk';
}

export function isTimestampsMessage(msg: CartesiaServerMessage): msg is CartesiaTimestampsMessage {
  return 'type' in msg && msg.type === 'timestamps';
}

export function isDoneMessage(msg: CartesiaServerMessage): msg is CartesiaDoneMessage {
  return 'type' in msg && msg.type === 'done';
}

export function isFlushDoneMessage(msg: CartesiaServerMessage): msg is CartesiaFlushDoneMessage {
  return 'type' in msg && msg.type === 'flush_done';
}

export function isErrorMessage(msg: CartesiaServerMessage): msg is CartesiaErrorMessage {
  return 'error' in msg && typeof msg.error === 'string';
}

export function hasWordTimestamps(msg: CartesiaServerMessage): msg is CartesiaTimestampsMessage {
  return isTimestampsMessage(msg);
}
