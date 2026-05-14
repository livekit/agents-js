// SPDX-FileCopyrightText: 2026 LiveKit, Inc.
//
// SPDX-License-Identifier: Apache-2.0
import { z } from 'zod';

export const readyMessageSchema = z.object({
  type: z.literal('ready'),
});

export const audioMessageSchema = z.object({
  type: z.literal('audio'),
  data: z.string(),
  client_req_id: z.string().optional(),
});

export const textSegmentMessageSchema = z.object({
  type: z.literal('text'),
  text: z.string(),
  start_s: z.number().optional(),
  stop_s: z.number().optional(),
  client_req_id: z.string().optional(),
});

export const eosMessageSchema = z.object({
  type: z.literal('end_of_stream'),
  client_req_id: z.string().optional(),
});

export const errorMessageSchema = z.object({
  type: z.literal('error'),
  message: z.string(),
  code: z.number().optional(),
});

export const gradiumServerMessageSchema = z.discriminatedUnion('type', [
  readyMessageSchema,
  audioMessageSchema,
  textSegmentMessageSchema,
  eosMessageSchema,
  errorMessageSchema,
]);

export type GradiumReadyMessage = z.infer<typeof readyMessageSchema>;
export type GradiumAudioMessage = z.infer<typeof audioMessageSchema>;
export type GradiumTextSegmentMessage = z.infer<typeof textSegmentMessageSchema>;
export type GradiumEosMessage = z.infer<typeof eosMessageSchema>;
export type GradiumErrorMessage = z.infer<typeof errorMessageSchema>;
export type GradiumServerMessage = z.infer<typeof gradiumServerMessageSchema>;

export const isReadyMessage = (msg: GradiumServerMessage): msg is GradiumReadyMessage =>
  msg.type === 'ready';
export const isAudioMessage = (msg: GradiumServerMessage): msg is GradiumAudioMessage =>
  msg.type === 'audio';
export const isTextSegmentMessage = (msg: GradiumServerMessage): msg is GradiumTextSegmentMessage =>
  msg.type === 'text';
export const isEosMessage = (msg: GradiumServerMessage): msg is GradiumEosMessage =>
  msg.type === 'end_of_stream';
export const isErrorMessage = (msg: GradiumServerMessage): msg is GradiumErrorMessage =>
  msg.type === 'error';
