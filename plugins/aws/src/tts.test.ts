// SPDX-FileCopyrightText: 2026 LiveKit, Inc.
//
// SPDX-License-Identifier: Apache-2.0
import type { PollyClient } from '@aws-sdk/client-polly';
import { APIConnectionError, APIStatusError } from '@livekit/agents';
import { tts as ttsTest } from '@livekit/agents-plugins-test';
import { describe, expect, it } from 'vitest';
import { STT } from './stt.js';
import { TTS } from './tts.js';
import { toAwsApiError } from './utils.js';

const hasAwsCredentials = Boolean(process.env.AWS_ACCESS_KEY_ID || process.env.AWS_PROFILE);

function pcmBytes(sampleCount: number): Uint8Array {
  return new Uint8Array(sampleCount * 2); // 16-bit PCM, mono
}

function fakeClient(audioBytes: Uint8Array, requestId = 'req_123'): PollyClient {
  return {
    send: async () => ({
      $metadata: { requestId },
      AudioStream: {
        transformToByteArray: async () => audioBytes,
      },
    }),
  } as unknown as PollyClient;
}

describe('AWS Polly TTS - constructor', () => {
  it('defaults to Ruth, generative engine, and 16000 Hz', () => {
    const tts = new TTS({ client: fakeClient(pcmBytes(0)) });
    expect(tts.sampleRate).toBe(16000);
    expect(tts.numChannels).toBe(1);
    expect(tts.model).toBe('generative');
    expect(tts.provider).toBe('Amazon Polly');
    expect(tts.capabilities.streaming).toBe(false);
  });

  it('accepts 8000 Hz', () => {
    const tts = new TTS({ sampleRate: 8000, client: fakeClient(pcmBytes(0)) });
    expect(tts.sampleRate).toBe(8000);
  });

  it('throws for unsupported sample rates', () => {
    expect(() => new TTS({ sampleRate: 24000 })).toThrow(/8000 or 16000/);
  });

  it('throws when streaming is requested', () => {
    const tts = new TTS({ client: fakeClient(pcmBytes(0)) });
    expect(() => tts.stream()).toThrow(/Streaming is not supported/);
  });

  it('merges updateOptions onto the existing options', () => {
    const tts = new TTS({ client: fakeClient(pcmBytes(0)) });
    tts.updateOptions({ voice: 'Matthew', speechEngine: 'neural' });
    expect(tts.model).toBe('neural');
  });
});

describe('AWS Polly TTS - synthesis', () => {
  it('flushes a PCM response shorter than one 100ms frame', async () => {
    const tts = new TTS({ sampleRate: 16000, client: fakeClient(pcmBytes(800)) });
    const stream = tts.synthesize('hello world');

    const events = [];
    for await (const event of stream) {
      events.push(event);
    }

    expect(events).toHaveLength(1);
    expect(events.at(-1)?.final).toBe(true);
    expect(events.reduce((sum, event) => sum + event.frame.samplesPerChannel, 0)).toBe(800);
    for (const event of events) {
      expect(event.frame.sampleRate).toBe(16000);
      expect(event.frame.channels).toBe(1);
      // A trailing empty flush() frame must never become the reported final frame.
      expect(event.frame.samplesPerChannel).toBeGreaterThan(0);
    }
  });

  it('does not emit an empty final frame when the PCM divides evenly into 100ms frames', async () => {
    // 1600 samples at 16000 Hz is exactly one 100ms frame, leaving nothing buffered for
    // flush() — flush() still returns a 0-sample frame in that case, which must be dropped.
    const tts = new TTS({ sampleRate: 16000, client: fakeClient(pcmBytes(1600)) });
    const stream = tts.synthesize('hi');

    const events = [];
    for await (const event of stream) {
      events.push(event);
    }

    expect(events).toHaveLength(1);
    expect(events[0]?.final).toBe(true);
    expect(events[0]?.frame.samplesPerChannel).toBe(1600);
  });

  it('keeps the output queue open across a retryable Polly failure', async () => {
    let attempts = 0;
    const client = {
      send: async () => {
        attempts += 1;
        if (attempts === 1) {
          throw Object.assign(new Error('temporary outage'), {
            $metadata: { httpStatusCode: 503 },
          });
        }
        return {
          $metadata: { requestId: 'req_retry' },
          AudioStream: {
            transformToByteArray: async () => pcmBytes(1600),
          },
        };
      },
    } as unknown as PollyClient;
    const tts = new TTS({ sampleRate: 16000, client });
    const stream = tts.synthesize('retry me', {
      maxRetry: 1,
      retryIntervalMs: 1,
      timeoutMs: 1000,
    });

    const events = [];
    for await (const event of stream) events.push(event);

    expect(attempts).toBe(2);
    expect(events).toHaveLength(1);
    expect(events[0]?.final).toBe(true);
  });

  // Error classification for Polly failures goes through toAwsApiError (used by
  // ChunkedStream.run). Exercise the mapper directly — driving the full stream
  // would also surface a by-design floating rejection from ThrowsPromise.
  it('maps Polly service errors with an HTTP status to non-retryable APIStatusError', () => {
    const err = Object.assign(new Error('Invalid voice id'), {
      name: 'InvalidParameterException',
      $metadata: { httpStatusCode: 400, requestId: 'req_bad_voice' },
    });

    const error = toAwsApiError(err, 'aws polly tts');
    expect(error).toBeInstanceOf(APIStatusError);
    const statusError = error as APIStatusError;
    expect(statusError.statusCode).toBe(400);
    expect(statusError.retryable).toBe(false);
    expect(statusError.requestId).toBe('req_bad_voice');
    expect(statusError.message).toMatch(/Invalid voice id/);
  });

  it('maps Polly errors without an HTTP status to APIConnectionError', () => {
    const error = toAwsApiError(new Error('network reset'), 'aws polly tts');
    expect(error).toBeInstanceOf(APIConnectionError);
    expect(error).not.toBeInstanceOf(APIStatusError);
    expect(error.message).toMatch(/network reset/);
  });
});

describe('AWS Polly TTS (live)', () => {
  if (hasAwsCredentials) {
    it('passes the shared TTS test harness', async () => {
      await ttsTest(new TTS(), new STT(), { streaming: false });
    });
  } else {
    it.skip('requires AWS_ACCESS_KEY_ID or AWS_PROFILE', () => {});
  }
});
