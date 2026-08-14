// SPDX-FileCopyrightText: 2026 LiveKit, Inc.
//
// SPDX-License-Identifier: Apache-2.0
import { describe, expect, it, vi } from 'vitest';
import type { InterruptionMetrics } from '../../metrics/base.js';
import { MockWebSocket } from './_mock_ws.js';
import { AdaptiveInterruptionDetector } from './interruption_detector.js';
import { InterruptionStreamBase, InterruptionStreamSentinel } from './interruption_stream.js';

vi.mock('ws', async () => {
  const { MockWebSocket } = await import('./_mock_ws.js');
  return { default: MockWebSocket, WebSocket: MockWebSocket };
});

describe('InterruptionStreamBase metrics', () => {
  it('does not count agent-ended overlap as a backchannel', async () => {
    MockWebSocket.instances.length = 0;
    const detector = new AdaptiveInterruptionDetector({
      apiKey: 'test-key',
      apiSecret: 'test-secret',
      baseUrl: 'http://localhost:9999',
    });
    const stream = new InterruptionStreamBase(detector, {});
    const metrics: InterruptionMetrics[] = [];
    detector.on('metrics_collected', (event) => metrics.push(event));
    const reader = stream.stream().getReader();

    try {
      await vi.waitFor(() => expect(MockWebSocket.instances).toHaveLength(1));
      MockWebSocket.instances[0]!.simulateOpen();
      const event = reader.read();
      await stream.pushFrame(InterruptionStreamSentinel.agentSpeechStarted());
      await stream.pushFrame(InterruptionStreamSentinel.overlapSpeechStarted(0, Date.now()));
      await stream.pushFrame(InterruptionStreamSentinel.overlapSpeechEnded(Date.now(), true));
      await event;

      expect(metrics).toHaveLength(1);
      expect(metrics[0]).toMatchObject({ numInterruptions: 0, numBackchannels: 0 });
    } finally {
      await reader.cancel();
      await stream.close();
    }
  });
});
