// SPDX-FileCopyrightText: 2026 LiveKit, Inc.
//
// SPDX-License-Identifier: Apache-2.0
import { AudioFrame } from '@livekit/rtc-node';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { MockWebSocket } from './_mock_ws.js';
import { AdaptiveInterruptionDetector } from './interruption_detector.js';
import { InterruptionStreamBase, InterruptionStreamSentinel } from './interruption_stream.js';
import type { OverlappingSpeechEvent } from './types.js';

vi.mock('ws', async () => {
  const { MockWebSocket } = await import('./_mock_ws.js');
  return { default: MockWebSocket, WebSocket: MockWebSocket };
});

function makeAudioFrame(): AudioFrame {
  const samples = new Int16Array(1600);
  return new AudioFrame(samples, 16000, 1, samples.length);
}

function requestIds(ws: MockWebSocket): number[] {
  return ws.sent
    .filter((frame): frame is Uint8Array => frame instanceof Uint8Array)
    .map((frame) => {
      const view = new DataView(frame.buffer, frame.byteOffset, 8);
      return view.getUint32(0, true) + view.getUint32(4, true) * 0x100000000;
    });
}

async function openStream(): Promise<{
  stream: InterruptionStreamBase;
  reader: ReadableStreamDefaultReader<OverlappingSpeechEvent>;
  ws: MockWebSocket;
}> {
  const detector = new AdaptiveInterruptionDetector({
    baseUrl: 'http://localhost:9999',
    apiKey: 'test-key',
    apiSecret: 'test-secret',
    threshold: 0.5,
  });
  const stream = new InterruptionStreamBase(detector, {});
  const reader = stream.stream().getReader();

  await vi.waitFor(() => expect(MockWebSocket.instances).toHaveLength(1));
  const ws = MockWebSocket.instances[0]!;
  ws.simulateOpen();
  await vi.waitFor(() => expect(ws.sent).toHaveLength(1));

  return { stream, reader, ws };
}

async function startAgentOverlap(
  stream: InterruptionStreamBase,
  ws: MockWebSocket,
  expectedRequestCount: number,
): Promise<number> {
  await stream.pushFrame(InterruptionStreamSentinel.agentSpeechStarted());
  await stream.pushFrame(InterruptionStreamSentinel.overlapSpeechStarted(0, Date.now()));
  await stream.pushFrame(makeAudioFrame());
  await vi.waitFor(() => expect(requestIds(ws)).toHaveLength(expectedRequestCount));
  return requestIds(ws).at(-1)!;
}

async function endAgentOverlap(
  stream: InterruptionStreamBase,
  reader: ReadableStreamDefaultReader<OverlappingSpeechEvent>,
): Promise<void> {
  const event = reader.read();
  await stream.pushFrame(InterruptionStreamSentinel.overlapSpeechEnded(Date.now(), true));
  await stream.pushFrame(InterruptionStreamSentinel.agentSpeechEnded());
  await expect(event).resolves.toMatchObject({ value: { isInterruption: false } });
}

beforeEach(() => {
  MockWebSocket.instances.length = 0;
});

describe('interruption request speech boundaries', () => {
  it('ignores a late verdict from a previous agent speech', async () => {
    const { stream, reader, ws } = await openStream();

    try {
      const oldRequestId = await startAgentOverlap(stream, ws, 1);
      await endAgentOverlap(stream, reader);
      const newRequestId = await startAgentOverlap(stream, ws, 2);

      const verdict = reader.read();
      ws.simulateMessage({
        type: 'bargein_detected',
        created_at: oldRequestId,
        probabilities: [0.99, 0.99],
      });
      ws.simulateMessage({
        type: 'bargein_detected',
        created_at: newRequestId,
        probabilities: [0.75, 0.75],
      });

      await expect(verdict).resolves.toMatchObject({
        value: {
          isInterruption: true,
          probability: 0.75,
          speechInput: expect.any(Int16Array),
        },
      });
    } finally {
      await reader.cancel();
      await stream.close();
    }
  });

  it('ignores a late inference result from a previous agent speech', async () => {
    const { stream, reader, ws } = await openStream();

    try {
      const oldRequestId = await startAgentOverlap(stream, ws, 1);
      await endAgentOverlap(stream, reader);
      const newRequestId = await startAgentOverlap(stream, ws, 2);

      ws.simulateMessage({
        type: 'inference_done',
        created_at: oldRequestId,
        probabilities: [0.99, 0.99],
      });
      ws.simulateMessage({
        type: 'inference_done',
        created_at: newRequestId,
        probabilities: [0.25, 0.25],
      });

      const result = reader.read();
      await stream.pushFrame(InterruptionStreamSentinel.overlapSpeechEnded(Date.now()));

      await expect(result).resolves.toMatchObject({
        value: {
          isInterruption: false,
          probability: 0.25,
          speechInput: expect.any(Int16Array),
        },
      });
    } finally {
      await reader.cancel();
      await stream.close();
    }
  });
});
