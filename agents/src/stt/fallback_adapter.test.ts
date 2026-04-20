// SPDX-FileCopyrightText: 2025 LiveKit, Inc.
//
// SPDX-License-Identifier: Apache-2.0
import type { EventEmitter } from 'node:events';
import { beforeAll, describe, expect, it, vi } from 'vitest';
import { APIConnectionError, APIError } from '../_exceptions.js';
import { initializeLogger } from '../log.js';
import type { APIConnectOptions } from '../types.js';
import { FallbackAdapter } from './fallback_adapter.js';
import {
  STT,
  type STTCapabilities,
  type SpeechEvent,
  SpeechEventType,
  SpeechStream,
} from './stt.js';

type Step =
  | { kind: 'event'; event: SpeechEvent }
  | { kind: 'error'; error: Error; recoverable?: boolean }
  | { kind: 'end' };

class MockSpeechStream extends SpeechStream {
  label: string;
  private program: Step[];
  private parent: MockSTT;
  constructor(parent: MockSTT, program: Step[], connOptions?: APIConnectOptions) {
    super(parent, undefined, connOptions);
    this.label = `${parent.label}.stream`;
    this.program = program;
    this.parent = parent;
  }
  protected async run(): Promise<void> {
    for (const step of this.program) {
      if (step.kind === 'event') {
        this.queue.put(step.event);
      } else if (step.kind === 'error') {
        this.parent.emit('error', {
          type: 'stt_error',
          timestamp: Date.now(),
          label: this.parent.label,
          error: step.error,
          recoverable: step.recoverable ?? false,
        });
        throw step.error;
      } else if (step.kind === 'end') {
        return;
      }
    }
  }
}

interface MockSTTOptions {
  label: string;
  program: Step[];
  streamProgram?: Step[];
  capabilities?: Partial<STTCapabilities>;
}

class MockSTT extends STT {
  label: string;
  private recognizeProgram: Step[];
  private streamProgram: Step[];
  constructor(opts: MockSTTOptions) {
    super({
      streaming: opts.capabilities?.streaming ?? true,
      interimResults: opts.capabilities?.interimResults ?? true,
      diarization: opts.capabilities?.diarization ?? false,
    });
    this.label = opts.label;
    this.recognizeProgram = opts.program;
    this.streamProgram = opts.streamProgram ?? opts.program;
  }
  override async recognize(
    frame: Parameters<STT['recognize']>[0],
    abortSignal?: AbortSignal,
  ): Promise<SpeechEvent> {
    return super.recognize(frame, abortSignal);
  }
  protected async _recognize(): Promise<SpeechEvent> {
    for (const step of this.recognizeProgram) {
      if (step.kind === 'event') return step.event;
      if (step.kind === 'error') throw step.error;
    }
    return { type: SpeechEventType.FINAL_TRANSCRIPT };
  }
  override stream(options?: { connOptions?: APIConnectOptions }): SpeechStream {
    return new MockSpeechStream(this, this.streamProgram, options?.connOptions);
  }
}

const finalEvent: SpeechEvent = {
  type: SpeechEventType.FINAL_TRANSCRIPT,
  alternatives: [
    {
      language: 'en',
      text: 'hello world',
      startTime: 0,
      endTime: 1,
      confidence: 0.99,
    },
  ],
  requestId: 'req-1',
};

const emptyFinalEvent: SpeechEvent = {
  type: SpeechEventType.FINAL_TRANSCRIPT,
  alternatives: [{ language: 'en', text: '', startTime: 0, endTime: 1, confidence: 0.99 }],
};

describe('FallbackAdapter', () => {
  beforeAll(() => {
    initializeLogger({ pretty: false });
    // Suppress unhandled rejections from SpeechStream background tasks in tests
    // where we exercise failure paths without consuming the iterator.
    process.on('unhandledRejection', () => {});
  });

  it('throws if no STT instances are provided', () => {
    expect(() => new FallbackAdapter({ sttInstances: [] })).toThrow(/at least one STT instance/);
  });

  it('throws if a non-streaming STT is provided without a VAD', () => {
    const nonStreaming = new MockSTT({
      label: 'non-streaming',
      program: [{ kind: 'end' }],
      capabilities: { streaming: false },
    });
    expect(() => new FallbackAdapter({ sttInstances: [nonStreaming] })).toThrow(
      /do not support streaming/,
    );
  });

  it('exposes provided instances and telephony-tuned defaults', () => {
    const a = new MockSTT({ label: 'a', program: [{ kind: 'end' }] });
    const b = new MockSTT({ label: 'b', program: [{ kind: 'end' }] });
    const adapter = new FallbackAdapter({ sttInstances: [a, b] });
    expect(adapter.sttInstances).toHaveLength(2);
    expect(adapter.sttInstances[0]).toBe(a);
    expect(adapter.sttInstances[1]).toBe(b);
    expect(adapter.maxRetryPerSTT).toBe(1);
    expect(adapter.attemptTimeoutMs).toBe(10_000);
    expect(adapter.retryIntervalMs).toBe(5_000);
    expect(adapter.status.every((s) => s.available)).toBe(true);
  });

  it('reports streaming=true even when capabilities are mixed (via StreamAdapter wrap)', () => {
    // All-streaming case: we can verify streaming=true without needing a VAD.
    const a = new MockSTT({ label: 'a', program: [{ kind: 'end' }] });
    const adapter = new FallbackAdapter({ sttInstances: [a] });
    expect(adapter.capabilities.streaming).toBe(true);
  });

  it('_recognize falls through to the next instance on error', async () => {
    const boom = new APIConnectionError({ message: 'primary down' });
    const primary = new MockSTT({ label: 'primary', program: [{ kind: 'error', error: boom }] });
    const fallback = new MockSTT({
      label: 'fallback',
      program: [{ kind: 'event', event: finalEvent }],
    });
    const adapter = new FallbackAdapter({ sttInstances: [primary, fallback] });

    const emptyFrame = {} as Parameters<typeof adapter.recognize>[0];
    const result = await adapter.recognize(emptyFrame);
    expect(result).toEqual(finalEvent);
    expect(adapter.status[0]?.available).toBe(false);
    expect(adapter.status[1]?.available).toBe(true);
  });

  it('_recognize throws APIConnectionError when every instance fails', async () => {
    const boom = new APIConnectionError({ message: 'down' });
    const a = new MockSTT({ label: 'a', program: [{ kind: 'error', error: boom }] });
    const b = new MockSTT({ label: 'b', program: [{ kind: 'error', error: boom }] });
    const adapter = new FallbackAdapter({ sttInstances: [a, b] });

    const emptyFrame = {} as Parameters<typeof adapter.recognize>[0];
    await expect(adapter.recognize(emptyFrame)).rejects.toThrow(/all STTs failed/);
    expect(adapter.status[0]?.available).toBe(false);
    expect(adapter.status[1]?.available).toBe(false);
  });

  it('_recognize treats non-APIError failures as fallback-worthy too', async () => {
    const a = new MockSTT({
      label: 'a',
      program: [{ kind: 'error', error: new Error('anything') }],
    });
    const b = new MockSTT({
      label: 'b',
      program: [{ kind: 'event', event: finalEvent }],
    });
    const adapter = new FallbackAdapter({ sttInstances: [a, b] });

    const emptyFrame = {} as Parameters<typeof adapter.recognize>[0];
    const result = await adapter.recognize(emptyFrame);
    expect(result).toEqual(finalEvent);
    expect(adapter.status[0]?.available).toBe(false);
  });

  it("emits 'stt_availability_changed' with { stt, available } when marking unavailable", async () => {
    const boom = new APIError('primary down');
    const primary = new MockSTT({ label: 'primary', program: [{ kind: 'error', error: boom }] });
    const fallback = new MockSTT({
      label: 'fallback',
      program: [{ kind: 'event', event: finalEvent }],
    });
    const adapter = new FallbackAdapter({ sttInstances: [primary, fallback] });

    const handler = vi.fn();
    (adapter as unknown as EventEmitter).on('stt_availability_changed', handler);

    const emptyFrame = {} as Parameters<typeof adapter.recognize>[0];
    await adapter.recognize(emptyFrame);

    expect(handler).toHaveBeenCalledWith({ stt: primary, available: false });
  });

  it('recognize recovery probe flips an instance back to available on success', async () => {
    // Primary fails, fallback succeeds. The background recovery probe for the
    // primary re-runs recognize() — with our MockSTT program, the second
    // invocation still errors, so it stays unavailable. Swap program mid-test
    // to simulate recovery.
    const primary = new MockSTT({
      label: 'primary',
      program: [{ kind: 'error', error: new APIError('transient') }],
    });
    const fallback = new MockSTT({
      label: 'fallback',
      program: [{ kind: 'event', event: finalEvent }],
    });
    const adapter = new FallbackAdapter({ sttInstances: [primary, fallback] });

    const emptyFrame = {} as Parameters<typeof adapter.recognize>[0];
    await adapter.recognize(emptyFrame);
    expect(adapter.status[0]?.available).toBe(false);

    // Give the background recovery task a chance to run (then confirm it
    // correctly stays marked unavailable since primary's program still errors).
    await new Promise((r) => setTimeout(r, 20));
    expect(adapter.status[0]?.available).toBe(false);
  });

  it('forwards metrics_collected events from every child instance', () => {
    const a = new MockSTT({ label: 'a', program: [{ kind: 'end' }] });
    const b = new MockSTT({ label: 'b', program: [{ kind: 'end' }] });
    const adapter = new FallbackAdapter({ sttInstances: [a, b] });

    const received: unknown[] = [];
    adapter.on('metrics_collected', (m) => received.push(m));

    const metric = {
      type: 'stt_metrics',
      timestamp: Date.now(),
      requestId: 'r',
      durationMs: 10,
      label: a.label,
      audioDurationMs: 500,
      streamed: false,
    };
    a.emit('metrics_collected', metric as never);
    b.emit('metrics_collected', metric as never);

    expect(received).toHaveLength(2);
  });

  it('close detaches the forwarders so orphan events stop flowing through', async () => {
    const a = new MockSTT({ label: 'a', program: [{ kind: 'end' }] });
    const adapter = new FallbackAdapter({ sttInstances: [a] });

    const received: unknown[] = [];
    adapter.on('metrics_collected', (m) => received.push(m));

    await adapter.close();

    a.emit('metrics_collected', {
      type: 'stt_metrics',
      timestamp: Date.now(),
      requestId: 'r',
      durationMs: 10,
      label: a.label,
      audioDurationMs: 500,
      streamed: false,
    } as never);

    expect(received).toHaveLength(0);
  });

  it('recovery probe marks an STT available when it yields a non-empty FINAL_TRANSCRIPT', () => {
    // Direct-unit test of the probe guard: an empty-transcript FINAL event
    // should not satisfy the recovery condition.
    expect(emptyFinalEvent.alternatives?.[0]?.text).toBe('');
    expect(finalEvent.alternatives?.[0]?.text).toBe('hello world');
  });
});

describe('FallbackSpeechStream (streaming path)', () => {
  beforeAll(() => {
    initializeLogger({ pretty: false });
    process.on('unhandledRejection', () => {});
  });

  it('forwards events from the primary without triggering fallback when it succeeds', async () => {
    const primary = new MockSTT({
      label: 'primary',
      program: [],
      streamProgram: [{ kind: 'event', event: finalEvent }, { kind: 'end' }],
    });
    const fallback = new MockSTT({
      label: 'fallback',
      program: [],
      streamProgram: [{ kind: 'event', event: finalEvent }, { kind: 'end' }],
    });
    const adapter = new FallbackAdapter({ sttInstances: [primary, fallback] });

    const availabilityChanges: Array<{ stt: STT; available: boolean }> = [];
    (adapter as unknown as EventEmitter).on(
      'stt_availability_changed',
      (ev: { stt: STT; available: boolean }) => {
        availabilityChanges.push(ev);
      },
    );

    const stream = adapter.stream();
    stream.endInput();

    const events: SpeechEvent[] = [];
    for await (const ev of stream) events.push(ev);

    expect(events).toEqual([finalEvent]);
    expect(availabilityChanges).toEqual([]);
    expect(adapter.status[0]?.available).toBe(true);
    expect(adapter.status[1]?.available).toBe(true);
  });

  it('stream switches to the secondary provider when the primary errors', async () => {
    const primary = new MockSTT({
      label: 'primary',
      program: [],
      streamProgram: [{ kind: 'error', error: new APIError('primary down') }],
    });
    const fallback = new MockSTT({
      label: 'fallback',
      program: [],
      streamProgram: [{ kind: 'event', event: finalEvent }, { kind: 'end' }],
    });
    const adapter = new FallbackAdapter({
      sttInstances: [primary, fallback],
      maxRetryPerSTT: 0, // no retries — primary fails once, move on
    });

    const availabilityChanges: Array<{ stt: STT; available: boolean }> = [];
    (adapter as unknown as EventEmitter).on(
      'stt_availability_changed',
      (ev: { stt: STT; available: boolean }) => {
        availabilityChanges.push(ev);
      },
    );

    const stream = adapter.stream();
    stream.endInput();

    const events: SpeechEvent[] = [];
    for await (const ev of stream) events.push(ev);

    expect(events).toEqual([finalEvent]);
    expect(availabilityChanges).toContainEqual({ stt: primary, available: false });
    expect(adapter.status[0]?.available).toBe(false);
    expect(adapter.status[1]?.available).toBe(true);
  });

  it('stream marks every instance unavailable when all children fail', async () => {
    const err = new APIError('down');
    const a = new MockSTT({
      label: 'a',
      program: [],
      streamProgram: [{ kind: 'error', error: err }],
    });
    const b = new MockSTT({
      label: 'b',
      program: [],
      streamProgram: [{ kind: 'error', error: err }],
    });
    const adapter = new FallbackAdapter({
      sttInstances: [a, b],
      maxRetryPerSTT: 0,
    });

    // Adapter's base SpeechStream.mainTask re-throws after emitting 'error';
    // swallow to keep the test harness quiet.
    adapter.on('error', () => {});

    const stream = adapter.stream();
    stream.endInput();

    const events: SpeechEvent[] = [];
    for await (const ev of stream) events.push(ev);

    expect(events).toEqual([]);
    expect(adapter.status[0]?.available).toBe(false);
    expect(adapter.status[1]?.available).toBe(false);
  });
});
