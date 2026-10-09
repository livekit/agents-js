// SPDX-FileCopyrightText: 2026 LiveKit, Inc.
//
// SPDX-License-Identifier: Apache-2.0
import { APIConnectionError, APIStatusError, APITimeoutError } from '@livekit/agents';
import type { AudioFrame } from '@livekit/rtc-node';
import type { Language } from './models.js';

export const API_BASE_URL = 'https://api.addisassistant.com';

export function validateLanguage(language: Language | string): Language {
  if (language !== 'am' && language !== 'om') {
    throw new Error('language must be "am" for Amharic or "om" for Afaan Oromo');
  }
  return language;
}

export function createWav(frame: AudioFrame): Uint8Array {
  const bitsPerSample = 16;
  const byteRate = (frame.sampleRate * frame.channels * bitsPerSample) / 8;
  const blockAlign = (frame.channels * bitsPerSample) / 8;
  const data = Buffer.from(frame.data.buffer, frame.data.byteOffset, frame.data.byteLength);
  const wav = Buffer.allocUnsafe(44 + data.byteLength);

  wav.write('RIFF', 0);
  wav.writeUInt32LE(36 + data.byteLength, 4);
  wav.write('WAVE', 8);
  wav.write('fmt ', 12);
  wav.writeUInt32LE(16, 16);
  wav.writeUInt16LE(1, 20);
  wav.writeUInt16LE(frame.channels, 22);
  wav.writeUInt32LE(frame.sampleRate, 24);
  wav.writeUInt32LE(byteRate, 28);
  wav.writeUInt16LE(blockAlign, 32);
  wav.writeUInt16LE(bitsPerSample, 34);
  wav.write('data', 36);
  wav.writeUInt32LE(data.byteLength, 40);
  data.copy(wav, 44);

  return new Uint8Array(wav.buffer, wav.byteOffset, wav.byteLength);
}

export function decodePcmWav(
  wav: Uint8Array,
  expectedSampleRate: number,
  expectedChannels: number,
): Uint8Array {
  const data = Buffer.from(wav.buffer, wav.byteOffset, wav.byteLength);
  if (
    data.byteLength < 12 ||
    data.toString('ascii', 0, 4) !== 'RIFF' ||
    data.toString('ascii', 8, 12) !== 'WAVE'
  ) {
    throw new APIConnectionError({
      message: 'AddisAI TTS returned audio that is not a WAV file',
      options: { retryable: false },
    });
  }

  let audioFormat: number | undefined;
  let channels: number | undefined;
  let sampleRate: number | undefined;
  let bitsPerSample: number | undefined;
  let pcm: Buffer | undefined;

  for (let offset = 12; offset + 8 <= data.byteLength; ) {
    const chunkId = data.toString('ascii', offset, offset + 4);
    const chunkSize = data.readUInt32LE(offset + 4);
    const chunkStart = offset + 8;
    const chunkEnd = chunkStart + chunkSize;
    if (chunkEnd > data.byteLength) {
      break;
    }

    if (chunkId === 'fmt ' && chunkSize >= 16) {
      audioFormat = data.readUInt16LE(chunkStart);
      channels = data.readUInt16LE(chunkStart + 2);
      sampleRate = data.readUInt32LE(chunkStart + 4);
      bitsPerSample = data.readUInt16LE(chunkStart + 14);
    } else if (chunkId === 'data') {
      pcm = data.subarray(chunkStart, chunkEnd);
    }

    offset = chunkEnd + (chunkSize % 2);
  }

  if (
    audioFormat !== 1 ||
    channels !== expectedChannels ||
    sampleRate !== expectedSampleRate ||
    bitsPerSample !== 16 ||
    !pcm
  ) {
    throw new APIConnectionError({
      message:
        `AddisAI TTS returned an unsupported WAV format ` +
        `(format=${audioFormat ?? 'unknown'}, channels=${channels ?? 'unknown'}, ` +
        `sampleRate=${sampleRate ?? 'unknown'}, bits=${bitsPerSample ?? 'unknown'})`,
      options: { retryable: false },
    });
  }

  return new Uint8Array(pcm.buffer, pcm.byteOffset, pcm.byteLength);
}

export async function parseJsonResponse(response: Response): Promise<Record<string, unknown>> {
  const text = await response.text();
  let payload: Record<string, unknown> = {};

  if (text) {
    try {
      const parsed: unknown = JSON.parse(text);
      if (isRecord(parsed)) payload = parsed;
    } catch {
      if (response.ok) {
        throw new APIConnectionError({
          message: 'AddisAI returned a non-JSON response',
          options: { retryable: true },
        });
      }
    }
  }

  if (!response.ok) {
    throw statusError(response, payload, text);
  }
  return payload;
}

export async function ensureSuccessfulResponse(response: Response): Promise<void> {
  if (response.ok) return;

  const text = await response.text();
  let payload: Record<string, unknown> = {};
  try {
    const parsed: unknown = JSON.parse(text);
    if (isRecord(parsed)) payload = parsed;
  } catch {
    // The status and a bounded response excerpt are enough for non-JSON errors.
  }
  throw statusError(response, payload, text);
}

export function unwrapData(payload: Record<string, unknown>): Record<string, unknown> {
  return isRecord(payload.data) ? payload.data : payload;
}

export function responseRequestId(response: Response): string | undefined {
  return (
    response.headers.get('x-request-id') ??
    response.headers.get('request-id') ??
    response.headers.get('x-correlation-id') ??
    undefined
  );
}

export function timedSignal(parent: AbortSignal, timeoutMs: number): AbortSignal {
  if (timeoutMs <= 0) return parent;
  return AbortSignal.any([parent, AbortSignal.timeout(timeoutMs)]);
}

export function mapFetchError(error: unknown, operation: string): never {
  if (error instanceof APIStatusError || error instanceof APIConnectionError) {
    throw error;
  }

  if (error instanceof Error && error.name === 'TimeoutError') {
    throw new APITimeoutError({ message: `AddisAI ${operation} request timed out` });
  }

  const message = error instanceof Error ? error.message : String(error);
  throw new APIConnectionError({
    message: `AddisAI ${operation} connection error: ${message}`,
    options: { retryable: true },
  });
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function statusError(
  response: Response,
  payload: Record<string, unknown>,
  rawText: string,
): APIStatusError {
  const nestedError = isRecord(payload.error) ? payload.error : undefined;
  const messageValue =
    nestedError?.message ?? payload.message ?? payload.detail ?? response.statusText;
  const message =
    typeof messageValue === 'string' && messageValue
      ? messageValue
      : rawText.slice(0, 300) || 'unknown error';

  return new APIStatusError({
    message: `AddisAI API error (${response.status}): ${message}`,
    options: {
      statusCode: response.status,
      requestId: responseRequestId(response),
      body: payload,
      retryable: response.status === 408 || response.status === 429 || response.status >= 500,
    },
  });
}
