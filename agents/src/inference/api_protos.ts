// SPDX-FileCopyrightText: 2025 LiveKit, Inc.
//
// SPDX-License-Identifier: Apache-2.0
import { z } from 'zod';

export const ttsSessionCreateEventSchema = z.object({
  type: z.literal('session.create'),
  sample_rate: z.string(),
  encoding: z.string(),
  model: z.string().optional(),
  voice: z.string().optional(),
  language: z.string().optional(),
  extra: z.record(z.string(), z.unknown()),
  transcript: z.string().optional(),
});

export const ttsInputTranscriptEventSchema = z.object({
  type: z.literal('input_transcript'),
  transcript: z.string(),
});

export const ttsSessionFlushEventSchema = z.object({
  type: z.literal('session.flush'),
});

export const ttsSessionCloseEventSchema = z.object({
  type: z.literal('session.close'),
});

export const ttsSessionCreatedEventSchema = z.object({
  type: z.literal('session.created'),
  session_id: z.string(),
});

export const ttsOutputAudioEventSchema = z.object({
  type: z.literal('output_audio'),
  audio: z.string(),
  session_id: z.string(),
});

export const ttsDoneEventSchema = z.object({
  type: z.literal('done'),
  session_id: z.string(),
});

export const ttsSessionClosedEventSchema = z.object({
  type: z.literal('session.closed'),
  session_id: z.string(),
});

export const ttsErrorEventSchema = z.object({
  type: z.literal('error'),
  message: z.string(),
  session_id: z.string(),
});

export const ttsClientEventSchema = z.discriminatedUnion('type', [
  ttsSessionCreateEventSchema,
  ttsInputTranscriptEventSchema,
  ttsSessionFlushEventSchema,
  ttsSessionCloseEventSchema,
]);

export const ttsServerEventSchema = z.discriminatedUnion('type', [
  ttsSessionCreatedEventSchema,
  ttsOutputAudioEventSchema,
  ttsDoneEventSchema,
  ttsSessionClosedEventSchema,
  ttsErrorEventSchema,
]);

export type TtsSessionCreateEvent = z.infer<typeof ttsSessionCreateEventSchema>;
export type TtsInputTranscriptEvent = z.infer<typeof ttsInputTranscriptEventSchema>;
export type TtsSessionFlushEvent = z.infer<typeof ttsSessionFlushEventSchema>;
export type TtsSessionCloseEvent = z.infer<typeof ttsSessionCloseEventSchema>;
export type TtsSessionCreatedEvent = z.infer<typeof ttsSessionCreatedEventSchema>;
export type TtsOutputAudioEvent = z.infer<typeof ttsOutputAudioEventSchema>;
export type TtsDoneEvent = z.infer<typeof ttsDoneEventSchema>;
export type TtsSessionClosedEvent = z.infer<typeof ttsSessionClosedEventSchema>;
export type TtsErrorEvent = z.infer<typeof ttsErrorEventSchema>;
export type TtsClientEvent = z.infer<typeof ttsClientEventSchema>;
export type TtsServerEvent = z.infer<typeof ttsServerEventSchema>;
