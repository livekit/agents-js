// SPDX-FileCopyrightText: 2026 LiveKit, Inc.
//
// SPDX-License-Identifier: Apache-2.0
//
// Tests for interruption detection failover (transport error production + error-emission)
// behavior. Ported from the Python `test_interruption_failover.py` suite.
//
// Covers, for the WebSocket-only transport (HTTP transport was dropped):
//   - connection timeout                -> non-retryable APITimeoutError
//   - connection 429                    -> non-retryable APIStatusError
//   - cache-based inference timeout     -> non-retryable APIStatusError (408)
// and that a non-retryable transport error surfaces as exactly one unrecoverable
// InterruptionDetectionError (zero recoverable) through AudioRecognition's retry loop.
import { AudioFrame } from '@livekit/rtc-node';
import { ReadableStream } from 'node:stream/web';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { APIError } from '../../_exceptions.js';
import { APIStatusError, APITimeoutError } from '../../_exceptions.js';
import { ChatContext } from '../../llm/chat_context.js';
import { initializeLogger } from '../../log.js';
import { AudioRecognition, type RecognitionHooks } from '../../voice/audio_recognition.js';
import { MockWebSocket } from './_mock_ws.js';
import { AdaptiveInterruptionDetector } from './interruption_detector.js';
import { InterruptionStreamBase, InterruptionStreamSentinel } from './interruption_stream.js';

// ---------------------------------------------------------------------------
// Mock `ws` so the WebSocket transport can be driven deterministically.
// ---------------------------------------------------------------------------

vi.mock('ws', async () => {
  const { MockWebSocket } = await import('./_mock_ws.js');
  return { default: MockWebSocket, WebSocket: MockWebSocket };
});

type MockSocket = MockWebSocket;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

initializeLogger({ pretty: false, level: 'silent' });

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

async function waitForInstance(timeoutMs = 2000): Promise<MockSocket> {
  const start = performance.now();
  while (MockWebSocket.instances.length === 0) {
    if (performance.now() - start > timeoutMs) {
      throw new Error('WebSocket instance was never constructed');
    }
    await sleep(5);
  }
  return MockWebSocket.instances[MockWebSocket.instances.length - 1]!;
}

function makeAudioFrame(numSamples = 1600, sampleRate = 16000): AudioFrame {
  const data = new Int16Array(numSamples);
  return new AudioFrame(data, sampleRate, 1, numSamples);
}

function createDetector(opts: { inferenceTimeout?: number } = {}): AdaptiveInterruptionDetector {
  return new AdaptiveInterruptionDetector({
    baseUrl: 'http://localhost:9999',
    apiKey: 'test-key',
    apiSecret: 'test-secret',
    ...opts,
  });
}

/** Drain a stream's event side and return the rejection (or undefined on clean end). */
async function readError(stream: InterruptionStreamBase): Promise<unknown> {
  const reader = stream.stream().getReader();
  try {
    for (;;) {
      const { done } = await reader.read();
      if (done) return undefined;
    }
  } catch (e) {
    return e;
  } finally {
    try {
      reader.releaseLock();
    } catch {
      // already released
    }
  }
}

beforeEach(() => {
  MockWebSocket.instances.length = 0;
});

afterEach(() => {
  vi.clearAllMocks();
});

// ---------------------------------------------------------------------------
// WebSocket transport error production
// ---------------------------------------------------------------------------

describe('interruption WebSocket transport failover', () => {
  it('surfaces a non-retryable APITimeoutError on connection timeout', async () => {
    const detector = createDetector();
    // Short connect timeout so the test does not wait on the default.
    const stream = new InterruptionStreamBase(detector, { timeout: 50 });

    const err = await readError(stream);

    expect(err).toBeInstanceOf(APITimeoutError);
    expect((err as APIError).retryable).toBe(false);

    await stream.close();
  });

  it('surfaces a non-retryable APIStatusError on connection 429', async () => {
    const detector = createDetector();
    const stream = new InterruptionStreamBase(detector, {});

    const errPromise = readError(stream);
    const ws = await waitForInstance();
    ws.simulateUnexpectedResponse(429);

    const err = await errPromise;

    expect(err).toBeInstanceOf(APIStatusError);
    expect((err as APIStatusError).statusCode).toBe(429);
    expect((err as APIError).retryable).toBe(false);

    await stream.close();
  });

  it('surfaces a non-retryable 408 APIStatusError when inference responses time out', async () => {
    const inferenceTimeout = 50;
    const detector = createDetector({ inferenceTimeout });
    const stream = new InterruptionStreamBase(detector, {});

    const errPromise = readError(stream);
    const ws = await waitForInstance();
    ws.simulateOpen();
    // let ensureConnection() resolve and send session.create
    await sleep(5);

    // Drive overlap audio so the transport sends a request and caches it, then never
    // answers — the next slice must trip the cache-timeout guard.
    await stream.pushFrame(InterruptionStreamSentinel.agentSpeechStarted());
    await stream.pushFrame(InterruptionStreamSentinel.overlapSpeechStarted(500, Date.now()));
    await stream.pushFrame(makeAudioFrame());
    await sleep(inferenceTimeout + 40);
    await stream.pushFrame(makeAudioFrame());

    const err = await errPromise;

    expect(err).toBeInstanceOf(APIStatusError);
    expect((err as APIStatusError).statusCode).toBe(408);
    expect((err as APIError).retryable).toBe(false);

    await stream.close();
  });
});

// ---------------------------------------------------------------------------
// AudioRecognition error-emission classification
// ---------------------------------------------------------------------------

function createHooks(): RecognitionHooks {
  return {
    onInterruption: vi.fn(),
    onStartOfSpeech: vi.fn(),
    onVADInferenceDone: vi.fn(),
    onEndOfSpeech: vi.fn(),
    onInterimTranscript: vi.fn(),
    onFinalTranscript: vi.fn(),
    onPreemptiveGeneration: vi.fn(),
    retrieveChatCtx: () => ChatContext.empty(),
    onEndOfTurn: vi.fn(async () => true),
  };
}

describe('interruption failover error emission', () => {
  it('emits exactly one unrecoverable error for a non-retryable transport failure', async () => {
    // Mirrors how ws_transport constructs the connection-rejected error (retryable forced off).
    const transportError = new APIStatusError({
      message: 'WebSocket connection rejected with status 429',
      options: { statusCode: 429, retryable: false },
    });
    expect(transportError.retryable).toBe(false);

    const errors: Array<{ recoverable: boolean }> = [];
    const erroringStream = {
      stream: () =>
        new ReadableStream({
          start(controller) {
            controller.error(transportError);
          },
        }),
      pushFrame: async () => {},
      close: async () => {},
    };
    const mockDetector = {
      label: 'mock-detector',
      createStream: () => erroringStream,
      emitError: (e: { recoverable: boolean }) => errors.push(e),
    };

    const recognition = new AudioRecognition({
      recognitionHooks: createHooks(),
      interruptionDetection: mockDetector as unknown as AdaptiveInterruptionDetector,
    });

    const ac = new AbortController();
    const task = (
      recognition as unknown as {
        createInterruptionTask: (
          d: AdaptiveInterruptionDetector,
          signal: AbortSignal,
        ) => Promise<void>;
      }
    ).createInterruptionTask(mockDetector as unknown as AdaptiveInterruptionDetector, ac.signal);

    // The non-retryable path emits the unrecoverable error then blocks in `finally`
    // awaiting the (idle) input-forwarding task; abort to let it wind down.
    const start = performance.now();
    while (errors.length === 0 && performance.now() - start < 2000) {
      await sleep(5);
    }
    ac.abort();
    await task;

    expect(errors.filter((e) => e.recoverable)).toHaveLength(0);
    expect(errors.filter((e) => !e.recoverable)).toHaveLength(1);
  });
});
