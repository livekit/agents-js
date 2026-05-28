// SPDX-FileCopyrightText: 2026 LiveKit, Inc.
//
// SPDX-License-Identifier: Apache-2.0

/**
 * Tests for `CloudTransport` (cloud WS body, driven by the unified
 * `AudioTurnDetectorStreamImpl` stream).
 *
 * Uses an in-process fake WebSocket to drive the transport
 * deterministically. Covers:
 *
 * - Retry counter resets after a successful connect (so transient drops
 *   across the session lifetime don't accumulate toward `maxRetry`).
 * - All outbound messages are FIFO-ordered on the wire, even when control
 *   hooks fire synchronously between two awaited audio frames.
 *
 * Port of Python `tests/test_turn_detection_cloud_stream.py`.
 */
import { AgentInference } from '@livekit/protocol';
import { AudioFrame } from '@livekit/rtc-node';
import { describe, expect, it } from 'vitest';
import { APIConnectionError } from '../../_exceptions.js';
import { DEFAULT_API_CONNECT_OPTIONS } from '../../types.js';
import { AudioTurnDetector, type TurnDetectorOptions } from './base.js';
import { AudioTurnDetectorStreamImpl } from './detector.js';
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

class FakeDetector extends AudioTurnDetector {
  get model(): string {
    return 'eot-audio-cloud';
  }
  stream(): never {
    throw new Error('unused');
  }
}

interface MakeStreamResult {
  stream: AudioTurnDetectorStreamImpl;
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
  const turnOpts: TurnDetectorOptions = { sampleRate: 16000, thresholds: {} };
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
  const stream = new AudioTurnDetectorStreamImpl({
    detector,
    opts: turnOpts,
    cloudOpts,
    backend: 'cloud',
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

describe('CloudStreamSendOrdering', () => {
  it('inferenceStart precedes inputAudio (FIFO)', async () => {
    const { stream, fakeWs, transport } = makeStream({ connectScript: [null] });
    try {
      await waitUntilConnected(transport);
      stream.warmup();
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

  it('inferenceStart precedes inferenceStop (FIFO)', async () => {
    const { stream, fakeWs, transport } = makeStream({ connectScript: [null] });
    try {
      await waitUntilConnected(transport);
      stream.warmup();
      stream.deactivate('vad sos');
      await drainSendQueue(transport);

      const kinds = fakeWs.sent.map((m) => m.message.case);
      const startIdx = kinds.indexOf('inferenceStart');
      const stopIdx = kinds.indexOf('inferenceStop');
      expect(startIdx).toBeGreaterThanOrEqual(0);
      expect(stopIdx).toBeGreaterThanOrEqual(0);
      expect(startIdx).toBeLessThan(stopIdx);
    } finally {
      await stream.aclose();
    }
  });
});
