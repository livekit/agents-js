// SPDX-FileCopyrightText: 2026 LiveKit, Inc.
//
// SPDX-License-Identifier: Apache-2.0
//
// Regression tests for https://github.com/livekit/agents-js/issues/2119.
//
// A `bargein_detected` / `inference_done` response is matched to whichever overlap happens to be
// open when it lands, not to the overlap its request was cut for. A response that arrives after
// its own overlap ended, while a *later* overlap is open, used to be accepted and attributed to
// that later overlap — emitting `isInterruption: true` for user audio the model never scored.
//
// Plain response latency is enough to hit this: the gap between two overlaps inside one agent turn
// is often only a few hundred ms.
import { AudioFrame } from '@livekit/rtc-node';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { initializeLogger } from '../../log.js';
import { MockWebSocket } from './_mock_ws.js';
import { AdaptiveInterruptionDetector } from './interruption_detector.js';
import { InterruptionStreamBase, InterruptionStreamSentinel } from './interruption_stream.js';
import type { OverlappingSpeechEvent } from './types.js';

vi.mock('ws', async () => {
  const { MockWebSocket } = await import('./_mock_ws.js');
  return { default: MockWebSocket, WebSocket: MockWebSocket };
});

initializeLogger({ pretty: false, level: 'silent' });

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

async function waitForInstance(timeoutMs = 2000): Promise<MockWebSocket> {
  const start = performance.now();
  while (MockWebSocket.instances.length === 0) {
    if (performance.now() - start > timeoutMs) throw new Error('WebSocket was never constructed');
    await sleep(5);
  }
  return MockWebSocket.instances[MockWebSocket.instances.length - 1]!;
}

function makeAudioFrame(numSamples = 1600, sampleRate = 16000): AudioFrame {
  return new AudioFrame(new Int16Array(numSamples), sampleRate, 1, numSamples);
}

function createDetector(): AdaptiveInterruptionDetector {
  return new AdaptiveInterruptionDetector({
    baseUrl: 'http://localhost:9999',
    apiKey: 'test-key',
    apiSecret: 'test-secret',
  });
}

/** Drain the event side into an array without blocking the test. */
function collectEvents(stream: InterruptionStreamBase): OverlappingSpeechEvent[] {
  const events: OverlappingSpeechEvent[] = [];
  void (async () => {
    const reader = stream.stream().getReader();
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) return;
        if (value) events.push(value);
      }
    } catch {
      // stream errored or was torn down; the test asserts on what arrived before that
    }
  })();
  return events;
}

/** The 8-byte little-endian `created_at` header the transport prefixes to each audio request. */
function sentRequestIds(ws: MockWebSocket): number[] {
  return ws.sent
    .filter((f): f is Uint8Array => f instanceof Uint8Array)
    .map((frame) => {
      const view = new DataView(frame.buffer, frame.byteOffset, 8);
      return view.getUint32(0, true) + view.getUint32(4, true) * 0x100000000;
    });
}

/** Bring a stream up to an open socket with a server-provided threshold. */
async function openStream(): Promise<{ stream: InterruptionStreamBase; ws: MockWebSocket }> {
  const stream = new InterruptionStreamBase(createDetector(), {});
  const ws = await waitForInstance();
  ws.simulateOpen();
  await sleep(5);
  ws.simulateMessage({ type: 'session.created', default_threshold: 0.5 });
  await sleep(5);
  return { stream, ws };
}

beforeEach(() => {
  MockWebSocket.instances.length = 0;
});

afterEach(() => {
  vi.clearAllMocks();
});

describe('interruption overlap binding (#2119)', () => {
  it('does not attribute a late bargein from a closed overlap to a later overlap', async () => {
    const { stream, ws } = await openStream();
    const events = collectEvents(stream);

    // Overlap A: send one inference request, then let the overlap close unanswered.
    await stream.pushFrame(InterruptionStreamSentinel.agentSpeechStarted());
    await stream.pushFrame(InterruptionStreamSentinel.overlapSpeechStarted(500, Date.now()));
    await stream.pushFrame(makeAudioFrame());
    await sleep(20);

    const requestIds = sentRequestIds(ws);
    expect(requestIds.length).toBeGreaterThan(0);
    const overlapARequestId = requestIds[requestIds.length - 1]!;

    await stream.pushFrame(InterruptionStreamSentinel.overlapSpeechEnded(Date.now()));
    await sleep(20);

    // Overlap B opens a few hundred ms later, inside the same agent turn.
    await stream.pushFrame(InterruptionStreamSentinel.overlapSpeechStarted(500, Date.now()));
    await sleep(20);
    const beforeLateResponse = events.length;

    // Overlap A's response finally lands, while overlap B is open.
    ws.simulateMessage({
      type: 'bargein_detected',
      created_at: overlapARequestId,
      probabilities: [0.99, 0.99, 0.99, 0.99],
      prediction_duration: 0.05,
    });
    await sleep(30);

    const late = events.slice(beforeLateResponse);
    expect(late.filter((e) => e.isInterruption)).toEqual([]);

    await stream.close();
  });

  it('still reports an interruption when the request generation is no longer on record', async () => {
    // The generation ledger is bounded, so a very long overlap can evict a live request. Losing
    // that bookkeeping must fail open — dropping the response instead would suppress a genuine
    // interruption, which is worse than the misattribution this guard exists to prevent.
    const { stream, ws } = await openStream();
    const events = collectEvents(stream);

    await stream.pushFrame(InterruptionStreamSentinel.agentSpeechStarted());
    await stream.pushFrame(InterruptionStreamSentinel.overlapSpeechStarted(500, Date.now()));
    await stream.pushFrame(makeAudioFrame());
    await sleep(20);

    // A `created_at` the transport never recorded, standing in for an evicted ledger entry.
    ws.simulateMessage({
      type: 'bargein_detected',
      created_at: Math.floor(performance.now()),
      probabilities: [0.99, 0.99, 0.99, 0.99],
      prediction_duration: 0.05,
    });
    await sleep(30);

    expect(events.filter((e) => e.isInterruption).length).toBe(1);

    await stream.close();
  });

  it('still reports an interruption for a response belonging to the open overlap', async () => {
    const { stream, ws } = await openStream();
    const events = collectEvents(stream);

    await stream.pushFrame(InterruptionStreamSentinel.agentSpeechStarted());
    await stream.pushFrame(InterruptionStreamSentinel.overlapSpeechStarted(500, Date.now()));
    await stream.pushFrame(makeAudioFrame());
    await sleep(20);

    const requestIds = sentRequestIds(ws);
    expect(requestIds.length).toBeGreaterThan(0);

    ws.simulateMessage({
      type: 'bargein_detected',
      created_at: requestIds[requestIds.length - 1]!,
      probabilities: [0.99, 0.99, 0.99, 0.99],
      prediction_duration: 0.05,
    });
    await sleep(30);

    expect(events.filter((e) => e.isInterruption).length).toBe(1);

    await stream.close();
  });
});
