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
  message: z.string().optional(),
  session_id: z.string().optional(),
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

// ============================================================================
// STT Schemas
// ============================================================================

// Word-level timing data
export const sttWordSchema = z.object({
  word: z.string().optional().default(''),
  start: z.number().optional().default(0),
  end: z.number().optional().default(0),
  confidence: z.number().optional().default(0.0),
  extra: z.unknown().nullable().optional(),
});

// Interim transcript event
export const sttInterimTranscriptEventSchema = z.object({
  type: z.literal('interim_transcript'),
  session_id: z.string().optional(),
  transcript: z.string().optional().default(''),
  language: z.string().optional().default(''),
  start: z.number().optional().default(0),
  duration: z.number().optional().default(0),
  confidence: z.number().optional().default(1.0),
  words: z.array(sttWordSchema).optional().default([]),
  extra: z.unknown().nullable().optional(),
});

// Final transcript event
export const sttFinalTranscriptEventSchema = z.object({
  type: z.literal('final_transcript'),
  session_id: z.string().optional(),
  transcript: z.string().optional().default(''),
  language: z.string().optional().default(''),
  start: z.number().optional().default(0),
  duration: z.number().optional().default(0),
  confidence: z.number().optional().default(1.0),
  words: z.array(sttWordSchema).optional().default([]),
  extra: z.unknown().nullable().optional(),
});

// Session created event
export const sttSessionCreatedEventSchema = z.object({
  type: z.literal('session.created'),
  session_id: z.string().optional(),
});

// Session finalized event
export const sttSessionFinalizedEventSchema = z.object({
  type: z.literal('session.finalized'),
});

// Session closed event
export const sttSessionClosedEventSchema = z.object({
  type: z.literal('session.closed'),
});

// Error event
export const sttErrorEventSchema = z.object({
  type: z.literal('error'),
  message: z.string().optional(),
  code: z.string().optional(),
});

// Discriminated union for all STT server events
export const sttServerEventSchema = z.discriminatedUnion('type', [
  sttSessionCreatedEventSchema,
  sttSessionFinalizedEventSchema,
  sttSessionClosedEventSchema,
  sttInterimTranscriptEventSchema,
  sttFinalTranscriptEventSchema,
  sttErrorEventSchema,
]);

// Type exports for STT
export type SttWord = z.infer<typeof sttWordSchema>;
export type SttInterimTranscriptEvent = z.infer<typeof sttInterimTranscriptEventSchema>;
export type SttFinalTranscriptEvent = z.infer<typeof sttFinalTranscriptEventSchema>;
export type SttTranscriptEvent = SttInterimTranscriptEvent | SttFinalTranscriptEvent;
export type SttSessionCreatedEvent = z.infer<typeof sttSessionCreatedEventSchema>;
export type SttSessionFinalizedEvent = z.infer<typeof sttSessionFinalizedEventSchema>;
export type SttSessionClosedEvent = z.infer<typeof sttSessionClosedEventSchema>;
export type SttErrorEvent = z.infer<typeof sttErrorEventSchema>;
export type SttServerEvent = z.infer<typeof sttServerEventSchema>;
