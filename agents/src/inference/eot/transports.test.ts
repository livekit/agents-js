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
 */
import { AgentInference } from '@livekit/protocol';
import { AudioFrame } from '@livekit/rtc-node';
import { describe, expect, it, vi } from 'vitest';
import { APIConnectionError } from '../../_exceptions.js';
import type { InferenceExecutor } from '../../ipc/inference_executor.js';
import { ChatContext, FunctionCall, FunctionCallOutput } from '../../llm/chat_context.js';
import { DEFAULT_API_CONNECT_OPTIONS } from '../../types.js';
import type { Task } from '../../utils.js';
import { BaseStreamingTurnDetector, type BaseStreamingTurnDetectorOptions } from './base.js';
import { TurnDetectorStreamImpl } from './detector.js';
import { ThresholdOptions, type TurnDetectorModel } from './languages.js';
import { CloudTransport, type CloudWebSocket, LocalTransport } from './transports.js';

const { ClientMessage } = AgentInference;
const EOT_MAX_SAMPLES = 32000;

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
  localFallback?: boolean;
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
    localFallback: opts.localFallback,
  });
  return { stream, fakeWs, transport };
}

async function tick(): Promise<void> {
  await new Promise<void>((r) => setImmediate(r));
}

async function waitUntilConnected(transport: CloudTransport, timeoutMs = 1000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (transport.transportReady()) return;
    await new Promise<void>((resolve) => setTimeout(resolve, 1));
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

function pcmFrame(samples = 320, value = 0): AudioFrame {
  return new AudioFrame(new Int16Array(samples).fill(value), 16000, 1, samples);
}

describe('CloudStreamRetry', () => {
  it('num retries resets after a successful connect', async () => {
    const { stream, transport } = makeStream({
      connectScript: [
        new APIConnectionError({ message: 'transient' }),
        new APIConnectionError({ message: 'transient' }),
        null,
      ],
      maxRetry: 3,
      retryIntervalMs: 10,
    });
    try {
      await waitUntilConnected(transport);
      // Three attempts: two failures increment the counter, then success resets it to 0.
      expect(transport.connectCalls).toBe(3);
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

describe('CloudWithoutLocalFallback', () => {
  it('releases the audio reader and defaults predictions when the socket closes', async () => {
    const { stream, transport, fakeWs } = makeStream({ localFallback: false });
    try {
      await waitUntilConnected(transport);
      stream.pushAudio(pcmFrame());
      await drainSendQueue(transport);
      expect(fakeWs.sent.some((m) => m.message.case === 'inputAudio')).toBe(true);

      const prediction = stream.predict();
      fakeWs.close();
      expect((await prediction.await).endOfTurnProbability).toBe(1);
      await (stream as unknown as { _mainTask: Task<void> })._mainTask.result;

      expect(stream.model).toBe('turn-detector-v1');
      expect(stream.isFallback).toBe(false);
      expect(transport.connectCalls).toBe(1);
      const sentBefore = fakeWs.sent.length;
      stream.pushAudio(pcmFrame());
      stream.flush();
      expect((await stream.predict().await).endOfTurnProbability).toBe(1);
      await stream._drainAudioChannel();
      expect(fakeWs.sent).toHaveLength(sentBefore);
    } finally {
      await stream.aclose();
    }
  });
});

describe('CloudStreamSendOrdering', () => {
  it('audio captured before predict precedes inferenceStart', async () => {
    const { stream, fakeWs, transport } = makeStream({ connectScript: [null] });
    try {
      await waitUntilConnected(transport);
      stream.pushAudio(pcmFrame());
      stream.pushAudio(pcmFrame());
      stream.predict();
      stream.pushAudio(pcmFrame());
      await drainSendQueue(transport);

      const kinds = fakeWs.sent
        .map((m) => m.message.case)
        .filter((kind) => kind !== 'sessionCreate');
      expect(kinds).toEqual([
        'inputAudio',
        'inputAudio',
        'eotInputChatContext',
        'inferenceStart',
        'inputAudio',
      ]);
      const start = fakeWs.sent.find((m) => m.message.case === 'inferenceStart');
      expect(start?.message.case === 'inferenceStart' && start.message.value.turnSamples).toBe(640);
    } finally {
      await stream.aclose();
    }
  });

  it('consecutive inferenceStarts are serialized in call order', async () => {
    // Two `runInference` hooks back-to-back (a predict superseding another)
    // can race at `ws.send`; the unified send channel serializes them in
    // call order.
    const { stream, fakeWs, transport } = makeStream({ connectScript: [null] });
    try {
      await waitUntilConnected(transport);
      const firstCtx = ChatContext.empty();
      firstCtx.addMessage({ role: 'assistant', content: 'First question' });
      stream.predict(firstCtx);
      const firstId = (stream as unknown as { _requestId?: string })._requestId;
      await drainSendQueue(transport);
      const secondCtx = ChatContext.empty();
      secondCtx.addMessage({ role: 'assistant', content: 'Second question' });
      stream.predict(secondCtx);
      const secondId = (stream as unknown as { _requestId?: string })._requestId;
      await drainSendQueue(transport);

      const startIds: (string | undefined)[] = [];
      for (const m of fakeWs.sent) {
        if (m.message.case === 'inferenceStart') {
          startIds.push(m.message.value.requestId);
        }
      }
      expect(startIds).toEqual([firstId, secondId]);
      expect(
        fakeWs.sent
          .filter((m) => m.message.case === 'eotInputChatContext')
          .map((m) =>
            m.message.case === 'eotInputChatContext'
              ? m.message.value.messages[0]?.content[0]?.payload.value
              : undefined,
          ),
      ).toEqual(['First question', 'Second question']);
    } finally {
      await stream.aclose();
    }
  });

  it('does not send a request replaced before the transport reaches it', async () => {
    const { stream, fakeWs, transport } = makeStream({ connectScript: [null] });
    try {
      await waitUntilConnected(transport);
      stream.predict();
      stream.predict();
      const secondId = (stream as unknown as { _requestId?: string })._requestId;
      await drainSendQueue(transport);
      const starts = fakeWs.sent
        .filter((m) => m.message.case === 'inferenceStart')
        .map((m) => (m.message.case === 'inferenceStart' ? m.message.value.requestId : undefined));
      expect(starts).toEqual([secondId]);
    } finally {
      await stream.aclose();
    }
  });
});

describe('CloudStreamChatContext', () => {
  it('sends only the last assistant text and snapshots it at predict', async () => {
    const chatCtx = ChatContext.empty();
    chatCtx.addMessage({ role: 'system', content: 'System instructions' });
    chatCtx.addMessage({ role: 'assistant', content: 'Earlier question' });
    chatCtx.addMessage({ role: 'user', content: 'Earlier answer' });
    chatCtx.addMessage({
      role: 'assistant',
      content: ['Which city?', "<expr value='curious'/>どちらですか？"],
    });
    chatCtx.items.push(FunctionCall.create({ callId: 'call', name: 'lookup', args: '{}' }));
    chatCtx.items.push(FunctionCallOutput.create({ callId: 'call', output: 'result' }));
    chatCtx.addMessage({ role: 'user', content: 'Current answer' });

    const { stream, fakeWs, transport } = makeStream({ connectScript: [null] });
    try {
      await waitUntilConnected(transport);
      stream.predict(chatCtx);
      chatCtx.addMessage({ role: 'assistant', content: 'Later question' });
      await drainSendQueue(transport);
      const context = fakeWs.sent.find((m) => m.message.case === 'eotInputChatContext');
      expect(context?.message.case).toBe('eotInputChatContext');
      if (context?.message.case !== 'eotInputChatContext') throw new Error('missing context');
      expect(context.message.value.messages).toHaveLength(1);
      expect(context.message.value.messages[0]?.content[0]?.payload.value).toBe(
        'Which city?\nどちらですか？',
      );
    } finally {
      await stream.aclose();
    }
  });

  const noAssistant = ChatContext.empty();
  noAssistant.addMessage({ role: 'user', content: 'Hello' });
  const emptyLastAssistant = ChatContext.empty();
  emptyLastAssistant.addMessage({ role: 'assistant', content: 'Earlier question' });
  emptyLastAssistant.addMessage({ role: 'assistant', content: [] });

  it.each([undefined, ChatContext.empty(), noAssistant, emptyLastAssistant])(
    'clears previous assistant text when context has none',
    async (chatCtx) => {
      const { stream, fakeWs, transport } = makeStream({ connectScript: [null] });
      try {
        await waitUntilConnected(transport);
        const old = ChatContext.empty();
        old.addMessage({ role: 'assistant', content: 'Old question' });
        stream.predict(old);
        await drainSendQueue(transport);
        stream.predict(chatCtx);
        await drainSendQueue(transport);
        const contexts = fakeWs.sent.filter((m) => m.message.case === 'eotInputChatContext');
        const last = contexts.at(-1);
        expect(
          last?.message.case === 'eotInputChatContext' && last.message.value.messages,
        ).toHaveLength(0);
      } finally {
        await stream.aclose();
      }
    },
  );
});

describe('CloudStreamTurnSamples', () => {
  it('counts from the turn start and resets on flush', async () => {
    const { stream, fakeWs, transport } = makeStream({ connectScript: [null] });
    try {
      await waitUntilConnected(transport);
      await transport.pushFrame(pcmFrame(8000));
      await transport.pushFrame(pcmFrame(4000));
      transport.onStartOfTurn(250);
      for (let i = 0; i < 100; i++) await transport.pushFrame(pcmFrame(1600));
      transport.runInference('past-window');
      await transport.flush({ kind: 'flush' });
      await transport.pushFrame(pcmFrame(320));
      transport.runInference('after-flush');
      await drainSendQueue(transport);
      const starts = Object.fromEntries(
        fakeWs.sent
          .filter((m) => m.message.case === 'inferenceStart')
          .map((m) =>
            m.message.case === 'inferenceStart'
              ? [m.message.value.requestId, m.message.value.turnSamples]
              : ['', 0],
          ),
      );
      expect(starts).toEqual({ 'past-window': 164000, 'after-flush': 320 });
    } finally {
      await stream.aclose();
    }
  });
});

describe('LocalTransportInput', () => {
  function makeLocal() {
    const calls: Array<{ pcm: string; turnSamples: number }> = [];
    const executor = {
      doInference: vi.fn(async (_method: string, input: { pcm: string; turnSamples: number }) => {
        calls.push(input);
        return { probability: 0.5, inferenceDurationMs: 0 };
      }),
    } as unknown as InferenceExecutor;
    const opts: BaseStreamingTurnDetectorOptions = {
      sampleRate: 16000,
      thresholds: new ThresholdOptions('turn-detector-v1-mini'),
    };
    const transport = new LocalTransport({ opts, executor });
    transport.attach({ _resolvePrediction: vi.fn() } as unknown as TurnDetectorStreamImpl);
    return { transport, calls };
  }

  async function predict(
    transport: LocalTransport,
    calls: Array<{ pcm: string; turnSamples: number }>,
  ) {
    transport.runInference('request');
    await vi.waitFor(() => expect(calls).toHaveLength(1));
    const call = calls[0]!;
    const bytes = Buffer.from(call.pcm, 'base64');
    return {
      pcm: new Int16Array(bytes.buffer, bytes.byteOffset, bytes.byteLength / 2),
      turnSamples: call.turnSamples,
    };
  }

  it('passes the last model window and the full turn length', async () => {
    const { transport, calls } = makeLocal();
    await transport.pushFrame(pcmFrame(8000));
    await transport.pushFrame(pcmFrame(4000));
    transport.onStartOfTurn(250);
    for (let i = 0; i < (2 * EOT_MAX_SAMPLES) / 1600; i++) {
      await transport.pushFrame(pcmFrame(1600));
    }
    const input = await predict(transport, calls);
    expect(input.pcm.length).toBe(EOT_MAX_SAMPLES);
    expect(input.turnSamples).toBe(4000 + 2 * EOT_MAX_SAMPLES);
  });

  it('drops audio before the turn start and resets on flush', async () => {
    const { transport, calls } = makeLocal();
    await transport.pushFrame(pcmFrame(EOT_MAX_SAMPLES, 1));
    await transport.pushFrame(pcmFrame(4000, 2));
    transport.onStartOfTurn(250);
    await transport.pushFrame(pcmFrame(1600, 2));
    const first = await predict(transport, calls);
    expect(first.pcm.length).toBe(5600);
    expect(first.turnSamples).toBe(5600);
    expect(first.pcm.every((sample) => sample === 2)).toBe(true);

    await transport.flush({ kind: 'flush' });
    calls.length = 0;
    await transport.pushFrame(pcmFrame(6000));
    const second = await predict(transport, calls);
    expect(second.pcm.length).toBe(6000);
    expect(second.turnSamples).toBe(6000);
  });

  it('clamps a turn start before the last flush to the buffered audio', async () => {
    const { transport, calls } = makeLocal();
    await transport.pushFrame(pcmFrame(1600));
    transport.onStartOfTurn(1000);
    const input = await predict(transport, calls);
    expect(input.pcm.length).toBe(1600);
    expect(input.turnSamples).toBe(1600);
  });
});
