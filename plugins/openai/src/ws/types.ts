// SPDX-FileCopyrightText: 2025 LiveKit, Inc.
//
// SPDX-License-Identifier: Apache-2.0
import { z } from 'zod';

// ============================================================================
// Client → Server events
// ============================================================================

export const wsResponseCreateEventSchema = z
  .object({
    type: z.literal('response.create'),
    model: z.string(),
    input: z.array(z.unknown()),
    tools: z.array(z.unknown()).optional(),
    previous_response_id: z.string().nullable().optional(),
    store: z.boolean().optional(),
    temperature: z.number().optional(),
    metadata: z.record(z.string(), z.string()).optional(),
  })
  .passthrough();

export type WsResponseCreateEvent = z.infer<typeof wsResponseCreateEventSchema>;

// ============================================================================
// Server → Client events
// ============================================================================

export const wsResponseCreatedEventSchema = z.object({
  type: z.literal('response.created'),
  response: z
    .object({
      id: z.string(),
    })
    .passthrough(),
});

export const wsFunctionCallItemSchema = z.object({
  type: z.literal('function_call'),
  call_id: z.string(),
  name: z.string(),
  arguments: z.string(),
});

export const wsOutputItemSchema = z.discriminatedUnion('type', [
  wsFunctionCallItemSchema,
  z.object({ type: z.literal('message') }).passthrough(),
  z.object({ type: z.literal('reasoning') }).passthrough(),
  z.object({ type: z.literal('file') }).passthrough(),
  z.object({ type: z.literal('computer_call') }).passthrough(),
  z.object({ type: z.literal('web_search_call') }).passthrough(),
]);

export const wsOutputItemDoneEventSchema = z.object({
  type: z.literal('response.output_item.done'),
  item: wsOutputItemSchema,
});

export const wsOutputTextDeltaEventSchema = z.object({
  type: z.literal('response.output_text.delta'),
  delta: z.string(),
});

export const wsResponseCompletedEventSchema = z.object({
  type: z.literal('response.completed'),
  response: z
    .object({
      id: z.string(),
      service_tier: z.string().nullable().optional(),
      usage: z
        .object({
          output_tokens: z.number(),
          input_tokens: z.number(),
          total_tokens: z.number(),
          input_tokens_details: z
            .object({
              cached_tokens: z.number(),
            })
            .passthrough(),
        })
        .optional(),
    })
    .passthrough(),
});

export const wsResponseFailedEventSchema = z.object({
  type: z.literal('response.failed'),
  response: z
    .object({
      id: z.string().optional(),
      error: z
        .object({
          code: z.string().optional(),
          message: z.string().optional(),
        })
        .optional(),
    })
    .passthrough(),
});

export const wsErrorEventSchema = z.object({
  type: z.literal('error'),
  status: z.number().optional(),
  error: z
    .object({
      type: z.string().optional(),
      code: z.string().optional(),
      message: z.string().optional(),
      param: z.string().optional(),
    })
    .optional(),
  message: z.string().optional(),
});

export const wsServerEventSchema = z.discriminatedUnion('type', [
  wsResponseCreatedEventSchema,
  wsOutputItemDoneEventSchema,
  wsOutputTextDeltaEventSchema,
  wsResponseCompletedEventSchema,
  wsResponseFailedEventSchema,
  wsErrorEventSchema,
]);

export type WsResponseCreatedEvent = z.infer<typeof wsResponseCreatedEventSchema>;
export type WsFunctionCallItem = z.infer<typeof wsFunctionCallItemSchema>;
export type WsOutputItem = z.infer<typeof wsOutputItemSchema>;
export type WsOutputItemDoneEvent = z.infer<typeof wsOutputItemDoneEventSchema>;
export type WsOutputTextDeltaEvent = z.infer<typeof wsOutputTextDeltaEventSchema>;
export type WsResponseCompletedEvent = z.infer<typeof wsResponseCompletedEventSchema>;
export type WsResponseFailedEvent = z.infer<typeof wsResponseFailedEventSchema>;
export type WsErrorEvent = z.infer<typeof wsErrorEventSchema>;
export type WsServerEvent = z.infer<typeof wsServerEventSchema>;
