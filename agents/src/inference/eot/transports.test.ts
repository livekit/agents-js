// SPDX-FileCopyrightText: 2026 LiveKit, Inc.
//
// SPDX-License-Identifier: Apache-2.0

/**
 * Tests for `CloudTransport` (cloud WS body, driven by the unified
 * `TurnDetectorStreamImpl` stream).
 *
 * Uses an in-process fake WebSocket to drive the transport
 * deterministically. Covers:
 *
 * - Retry counter resets after a successful connect (so transient drops
 *   across the session lifetime don't accumulate toward `maxRetry`).
 * - All outbound messages are FIFO-ordered on the wire, even when `runInference`
 *   hooks fire synchronously between two awaited audio frames.
 *
 * Port of Python `tests/test_turn_detection_cloud_stream.py`.
 */
import { AgentInference } from '@livekit/protocol';
import { AudioFrame } from '@livekit/rtc-node';
import { describe, expect, it } from 'vitest';
import { APIConnectionError } from '../../_exceptions.js';
import { DEFAULT_API_CONNECT_OPTIONS } from '../../types.js';
import { BaseStreamingTurnDetector, type BaseStreamingTurnDetectorOptions } from './base.js';
import { TurnDetectorStreamImpl } from './detector.js';
import { ThresholdOptions, type TurnDetectorModel } from './languages.js';
import { CloudTransport, type CloudWebSocket } from './transports.js';

const { ClientMessage } = AgentInference;

/** Fake WebSocket capturing outbound frames as parsed `ClientMessage`s. */
class FakeWS implements CloudWebSocket {
  sent: InstanceType<typeof ClientMessage>[] = [];
  readyState = 1; // OPEN
  private closeCbs: Array<() => void> = [];

  send(data: Uint8Array): void {
    if (this.readyState !== 1) throw new Error('ws closed');
    this.sent.push(ClientMessage.fromBinary(data));
  }
  close(): void {
    this.readyState = 3; // CLOSED
    for (const cb of this.closeCbs) cb();
  }
  on(event: 'message' | 'close' | 'error', cb: (...args: never[]) => void): void {
    if (event === 'close') this.closeCbs.push(cb as () => void);
    // message/error not driven in these tests
  }
}

class FakeDetector extends BaseStreamingTurnDetector {
  get model(): TurnDetectorModel {
    return 'turn-detector-v1';
  }
  stream(): never {
    throw new Error('unused');
  }
}

interface MakeStreamResult {
  stream: TurnDetectorStreamImpl;
  fakeWs: FakeWS;
  transport: CloudTransport;
}

function makeStream(opts: {
  connectScript?: Array<Error | null>;
  maxRetry?: number;
  retryIntervalMs?: number;
}): MakeStreamResult {
  const fakeWs = new FakeWS();
  const script = [...(opts.connectScript ?? [])];
  const turnOpts: BaseStreamingTurnDetectorOptions = {
    sampleRate: 16000,
    thresholds: new ThresholdOptions('turn-detector-v1'),
  };
  const detector = new FakeDetector(turnOpts);
  const cloudOpts = {
    baseUrl: '',
    apiKey: 'x',
    apiSecret: 'x',
    connOptions: {
      ...DEFAULT_API_CONNECT_OPTIONS,
      maxRetry: opts.maxRetry ?? 3,
      retryIntervalMs: opts.retryIntervalMs ?? 0,
    },
  };
  // Scripted connect: consume the script left-to-right. An Error rejects;
  // null (or exhausted) returns the fake ws.
  const connect = async (): Promise<CloudWebSocket> => {
    if (script.length > 0) {
      const r = script.shift();
      if (r instanceof Error) throw r;
    }
    fakeWs.readyState = 1;
    return fakeWs;
  };
  const transport = new CloudTransport({ detector, opts: turnOpts, cloudOpts, connect });
  const stream = new TurnDetectorStreamImpl({
    detector,
    opts: turnOpts,
    cloudOpts,
    model: 'turn-detector-v1',
    transport,
  });
  return { stream, fakeWs, transport };
}

async function tick(): Promise<void> {
  await new Promise<void>((r) => setImmediate(r));
}

async function waitUntilConnected(transport: CloudTransport, ticks = 50): Promise<void> {
  for (let i = 0; i < ticks; i++) {
    if (transport.transportReady()) return;
    await tick();
  }
  throw new Error('transport did not connect within timeout');
}

async function drainSendQueue(_transport: CloudTransport, ticks = 50): Promise<void> {
  // Let the sender task flush the buffered ClientMsgs to the fake socket.
  for (let i = 0; i < ticks; i++) {
    await tick();
  }
}

async function waitForCond(predicate: () => boolean, ticks = 50): Promise<void> {
  for (let i = 0; i < ticks; i++) {
    if (predicate()) return;
    await tick();
  }
}

function pcmFrame(samples = 320): AudioFrame {
  return new AudioFrame(new Int16Array(samples), 16000, 1, samples);
}

describe('CloudStreamRetry', () => {
  it('num retries resets after a successful connect', async () => {
    const { stream, transport } = makeStream({
      connectScript: [new APIConnectionError({ message: 'transient' }), null],
      maxRetry: 3,
      retryIntervalMs: 0,
    });
    try {
      await waitUntilConnected(transport);
      // Two attempts: first raised (counter 0→1), second succeeded → reset to 0.
      expect(transport.connectCalls).toBe(2);
      expect(transport.numRetries).toBe(0);
    } finally {
      await stream.aclose();
    }
  });
});

describe('CloudToLocalFallback', () => {
  it('releases the shared audio reader lock on fallback (regression)', async () => {
    const { stream, transport } = makeStream({ connectScript: [null] });
    try {
      await waitUntilConnected(transport);
      // Drive a frame so the cloud drain task is actively parked on
      // `reader.read()`, holding the audio channel's single reader lock.
      stream.pushAudio(pcmFrame());
      await tick();

      // A timed-out cancelInference triggers a cloud→local fallback. The
      // orphaned cloud drain must release the shared reader lock before the
      // real `LocalTransport.run()` re-acquires it — otherwise `getReader()`
      // throws "ReadableStream is locked", which is mis-reported as a local
      // failure.
      const fut = stream.predict();
      stream.cancelInference({ timedOut: true });
      await fut.await;

      await waitForCond(() => stream.model === 'turn-detector-v1-mini');
      expect(stream.isFallback).toBe(true);

      // Let the swapped-in LocalTransport.run() re-acquire the reader and start
      // draining. A freed lock ⇒ no "ReadableStream is locked" TypeError ⇒ no
      // local failure flagged.
      for (let i = 0; i < 10; i++) await tick();
      expect(stream.warnedLocalFailure).toBe(false);
    } finally {
      await stream.aclose();
    }
  });
});

describe('CloudStreamSendOrdering', () => {
  it('inferenceStart precedes inputAudio (FIFO)', async () => {
    const { stream, fakeWs, transport } = makeStream({ connectScript: [null] });
    try {
      await waitUntilConnected(transport);
      stream.predict();
      stream.pushAudio(pcmFrame());
      await drainSendQueue(transport);

      const kinds = fakeWs.sent.map((m) => m.message.case);
      const startIdx = kinds.indexOf('inferenceStart');
      const audioIdx = kinds.indexOf('inputAudio');
      expect(startIdx).toBeGreaterThanOrEqual(0);
      expect(audioIdx).toBeGreaterThanOrEqual(0);
      expect(startIdx).toBeLessThan(audioIdx);
    } finally {
      await stream.aclose();
    }
  });

  it('consecutive inferenceStarts are serialized in call order', async () => {
    // Two `runInference` hooks back-to-back (a predict superseding another)
    // used to race at `ws.send`; the unified send channel serializes them in
    // call order.
    const { stream, fakeWs, transport } = makeStream({ connectScript: [null] });
    try {
      await waitUntilConnected(transport);
      stream.predict();
      const firstId = (stream as unknown as { _requestId?: string })._requestId;
      stream.predict();
      const secondId = (stream as unknown as { _requestId?: string })._requestId;
      await drainSendQueue(transport);

      const startIds: (string | undefined)[] = [];
      for (const m of fakeWs.sent) {
        if (m.message.case === 'inferenceStart') {
          startIds.push(m.message.value.requestId);
        }
      }
      expect(startIds).toEqual([firstId, secondId]);
    } finally {
      await stream.aclose();
    }
  });
});
