// SPDX-FileCopyrightText: 2025 LiveKit, Inc.
//
// SPDX-License-Identifier: Apache-2.0
import type { EventEmitter } from 'node:events';
import { beforeAll, describe, expect, it, vi } from 'vitest';
import { APIConnectionError, APIError } from '../_exceptions.js';
import { ChatMessage } from '../llm/index.js';
import { initializeLogger } from '../log.js';
import type { APIConnectOptions } from '../types.js';
import { type AudioBuffer, delay } from '../utils.js';
import {
  type ConversationItemAddedEvent,
  createConversationItemAddedEvent,
} from '../voice/events.js';
import { FallbackAdapter } from './fallback_adapter.js';
import { STT, type SpeechEvent, SpeechEventType, SpeechStream } from './stt.js';
import { FakeSTT, RecognizeSentinel, emptyAudioFrame } from './testing/fake_stt.js';

type RetryTimelineMode = 'outer' | 'child';

class RetryTimelineSTT extends STT {
  label = 'retry-timeline-stt';
  mainStreams: RetryTimelineStream[] = [];
  private mainAttempts = 0;

  constructor(private readonly mode: RetryTimelineMode) {
    super({ streaming: true, interimResults: false });
  }

  protected async _recognize(_frame: AudioBuffer): Promise<SpeechEvent> {
    throw new APIConnectionError({ message: 'not used' });
  }

  override stream(options?: { connOptions?: APIConnectOptions }): RetryTimelineStream {
    const isRecoveryProbe = options?.connOptions?.maxRetry === 0;
    const mainAttempt = isRecoveryProbe ? 0 : ++this.mainAttempts;
    const stream = new RetryTimelineStream(this, this.mode, mainAttempt, options?.connOptions);
    if (!isRecoveryProbe) {
      this.mainStreams.push(stream);
    }
    return stream;
  }
}

class RetryTimelineStream extends SpeechStream {
  label = 'retry-timeline-stream';
  runOffsets: number[] = [];
  private runCount = 0;

  constructor(
    stt: STT,
    private readonly mode: RetryTimelineMode,
    private readonly mainAttempt: number,
    connOptions?: APIConnectOptions,
  ) {
    super(stt, undefined, connOptions);
  }

  protected async run(): Promise<void> {
    this.runCount += 1;
    this.runOffsets.push(this.startTimeOffset);

    if (this.mainAttempt === 0) {
      return;
    }

    if (this.mode === 'outer' && this.mainAttempt === 1) {
      await delay(25);
      throw new APIConnectionError({
        message: 'first main stream failed',
        options: { retryable: false },
      });
    }

    if (this.mode === 'child' && this.runCount === 1) {
      await delay(25);
      throw new APIConnectionError({ message: 'first child run failed' });
    }

    this.queue.put({
      type: SpeechEventType.FINAL_TRANSCRIPT,
      alternatives: [{ text: 'recovered', startTime: 0, endTime: 0, confidence: 1 }],
    });
    for await (const _ of this.input) {
      /* drain */
    }
  }
}

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
    const nonStreaming = new FakeSTT({
      label: 'non-streaming',
      capabilities: { streaming: false, interimResults: false },
    });
    expect(() => new FallbackAdapter({ sttInstances: [nonStreaming] })).toThrow(
      /do not support streaming/,
    );
  });

  it('exposes provided instances and telephony-tuned defaults', () => {
    const a = new FakeSTT({ label: 'a' });
    const b = new FakeSTT({ label: 'b' });
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
    const a = new FakeSTT({ label: 'a' });
    const adapter = new FallbackAdapter({ sttInstances: [a] });
    expect(adapter.capabilities.streaming).toBe(true);
  });

  it('forwards conversation context only to children that support it', () => {
    class ContextRecordingSTT extends FakeSTT {
      readonly conversationItems: ConversationItemAddedEvent[] = [];

      constructor(label: string, supportsChatContext: boolean) {
        super({ label });
        this.updateCapabilities({ chatContext: supportsChatContext });
      }

      override _pushConversationItem(ev: ConversationItemAddedEvent): void {
        this.conversationItems.push(ev);
      }
    }

    const supported = new ContextRecordingSTT('supported', true);
    const unsupported = new ContextRecordingSTT('unsupported', false);
    const adapter = new FallbackAdapter({ sttInstances: [supported, unsupported] });
    const event = createConversationItemAddedEvent(
      ChatMessage.create({ role: 'assistant', content: ['hello'] }),
    );

    adapter._pushConversationItem(event);

    expect(supported.conversationItems).toEqual([event]);
    expect(unsupported.conversationItems).toEqual([]);
  });

  it('tracks dynamic child conversation-context capabilities and removes listeners on close', async () => {
    class DynamicContextSTT extends FakeSTT {
      setChatContext(supported: boolean): void {
        this.updateCapabilities({ chatContext: supported });
      }
    }

    const child = new DynamicContextSTT();
    const adapter = new FallbackAdapter({ sttInstances: [child] });
    expect(adapter.capabilities.chatContext).toBe(false);
    expect(child.listenerCount('capabilities_changed')).toBe(1);

    child.setChatContext(true);
    expect(adapter.capabilities.chatContext).toBe(true);

    child.setChatContext(false);
    expect(adapter.capabilities.chatContext).toBe(false);

    await adapter.close();
    expect(child.listenerCount('capabilities_changed')).toBe(0);
  });

  it('_recognize falls through to the next instance on error', async () => {
    const primary = new FakeSTT({
      label: 'primary',
      fakeException: new APIConnectionError({ message: 'primary down' }),
    });
    const fallback = new FakeSTT({ label: 'fallback', fakeTranscript: 'hello world' });
    const adapter = new FallbackAdapter({ sttInstances: [primary, fallback] });

    const result = await adapter.recognize(emptyAudioFrame());
    expect(result.alternatives?.[0]?.text).toBe('hello world');
    expect(adapter.status[0]?.available).toBe(false);
    expect(adapter.status[1]?.available).toBe(true);

    // Observability: each STT saw exactly one recognize() attempt.
    expect((await primary.recognizeCh.next()).value).toBeInstanceOf(RecognizeSentinel);
    expect((await fallback.recognizeCh.next()).value).toBeInstanceOf(RecognizeSentinel);
  });

  it('_recognize throws APIConnectionError when every instance fails', async () => {
    const boom = new APIConnectionError({ message: 'down' });
    const a = new FakeSTT({ label: 'a', fakeException: boom });
    const b = new FakeSTT({ label: 'b', fakeException: boom });
    const adapter = new FallbackAdapter({ sttInstances: [a, b] });

    await expect(adapter.recognize(emptyAudioFrame())).rejects.toThrow(/all STTs failed/);
    expect(adapter.status[0]?.available).toBe(false);
    expect(adapter.status[1]?.available).toBe(false);
  });

  it('_recognize treats non-APIError failures as fallback-worthy too', async () => {
    const a = new FakeSTT({ label: 'a', fakeException: new Error('anything') });
    const b = new FakeSTT({ label: 'b', fakeTranscript: 'hello world' });
    const adapter = new FallbackAdapter({ sttInstances: [a, b] });

    const result = await adapter.recognize(emptyAudioFrame());
    expect(result.alternatives?.[0]?.text).toBe('hello world');
    expect(adapter.status[0]?.available).toBe(false);
  });

  it("emits 'stt_availability_changed' with { stt, available } when marking unavailable", async () => {
    const primary = new FakeSTT({
      label: 'primary',
      fakeException: new APIError('primary down'),
    });
    const fallback = new FakeSTT({ label: 'fallback', fakeTranscript: 'hello world' });
    const adapter = new FallbackAdapter({ sttInstances: [primary, fallback] });

    const handler = vi.fn();
    (adapter as unknown as EventEmitter).on('stt_availability_changed', handler);

    await adapter.recognize(emptyAudioFrame());

    expect(handler).toHaveBeenCalledWith({ stt: primary, available: false });
  });

  it('recognize recovery probe flips an instance back to available once it succeeds', async () => {
    // Port of Python's `test_stt_recover`. Primary starts broken, fallback
    // works. After the first recognize() marks primary unavailable, flipping
    // primary to success via updateOptions should let the background
    // recovery task mark it available again on the next recognize() call
    // (recovery is scheduled inside _recognize for every unavailable STT).
    const primary = new FakeSTT({
      label: 'primary',
      fakeException: new APIConnectionError({ message: 'primary down' }),
    });
    const fallback = new FakeSTT({ label: 'fallback', fakeTranscript: 'hello world' });
    const adapter = new FallbackAdapter({ sttInstances: [primary, fallback] });

    const availabilityEvents: Array<{ stt: STT; available: boolean }> = [];
    (adapter as unknown as EventEmitter).on(
      'stt_availability_changed',
      (ev: { stt: STT; available: boolean }) => {
        availabilityEvents.push(ev);
      },
    );

    await adapter.recognize(emptyAudioFrame());
    expect(adapter.status[0]?.available).toBe(false);
    expect(adapter.status[1]?.available).toBe(true);

    // Flip primary to success and trigger another recognize — that kicks
    // off a fresh recovery task for primary.
    primary.updateOptions({ fakeException: null, fakeTranscript: 'recovered' });
    await adapter.recognize(emptyAudioFrame());

    // Recovery runs asynchronously; poll briefly for the flip.
    const deadline = Date.now() + 500;
    while (Date.now() < deadline && !adapter.status[0]?.available) {
      await new Promise((r) => setTimeout(r, 5));
    }
    expect(adapter.status[0]?.available).toBe(true);
    expect(availabilityEvents.map((e) => ({ stt: e.stt.label, available: e.available }))).toEqual([
      { stt: 'primary', available: false },
      { stt: 'primary', available: true },
    ]);
  });

  it('recognize emits exactly one metrics_collected event (no double-count)', async () => {
    // Regression: base STT.recognize() emits its own metrics after _recognize()
    // returns. _recognize() delegates to a child's public recognize(), which
    // also emits metrics — and those child metrics are forwarded onto the
    // adapter. Without a recognize() override, consumers see two stt_metrics
    // events per call and RECOGNITION_USAGE is double-counted.
    const primary = new FakeSTT({ label: 'primary', fakeTranscript: 'hello' });
    const adapter = new FallbackAdapter({ sttInstances: [primary] });

    const received: unknown[] = [];
    adapter.on('metrics_collected', (m) => received.push(m));

    await adapter.recognize(emptyAudioFrame());

    expect(received).toHaveLength(1);
  });

  it('forwards metrics_collected events from every child instance', () => {
    const a = new FakeSTT({ label: 'a' });
    const b = new FakeSTT({ label: 'b' });
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
    const a = new FakeSTT({ label: 'a' });
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
});

describe('FallbackSpeechStream (streaming path)', () => {
  beforeAll(() => {
    initializeLogger({ pretty: false });
    process.on('unhandledRejection', () => {});
  });

  it('forwards events from the primary without triggering fallback when it succeeds', async () => {
    const primary = new FakeSTT({ label: 'primary', fakeTranscript: 'hello world' });
    const fallback = new FakeSTT({ label: 'fallback', fakeTranscript: 'hello world' });
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

    expect(events.map((e) => e.alternatives?.[0]?.text)).toEqual(['hello world']);
    expect(availabilityChanges).toEqual([]);
    expect(adapter.status[0]?.available).toBe(true);
    expect(adapter.status[1]?.available).toBe(true);
  });

  it('stream switches to the secondary provider when the primary errors', async () => {
    const primary = new FakeSTT({
      label: 'primary',
      fakeException: new APIError('primary down'),
    });
    const fallback = new FakeSTT({ label: 'fallback', fakeTranscript: 'hello world' });
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

    expect(events.map((e) => e.alternatives?.[0]?.text)).toEqual(['hello world']);
    expect(availabilityChanges).toContainEqual({ stt: primary, available: false });
    expect(adapter.status[0]?.available).toBe(false);
    expect(adapter.status[1]?.available).toBe(true);

    // Both providers saw a stream attempt via the observability channel.
    expect((await primary.streamCh.next()).done).toBe(false);
    expect((await fallback.streamCh.next()).done).toBe(false);
  });

  it('stream fallback propagates startTimeOffset to child streams', async () => {
    const primary = new FakeSTT({
      label: 'primary',
      fakeException: new APIConnectionError({ message: 'primary down' }),
    });
    const fallback = new FakeSTT({ label: 'fallback', fakeTranscript: 'hello world' });
    const adapter = new FallbackAdapter({
      sttInstances: [primary, fallback],
      maxRetryPerSTT: 0,
    });

    const stream = adapter.stream();
    stream.startTimeOffset = 30;
    stream.endInput();

    for await (const _ of stream) {
      /* drain */
    }

    const primaryStream = (await primary.streamCh.next()).value;
    const fallbackStream = (await fallback.streamCh.next()).value;
    expect(primaryStream?.startTimeOffset).toBeGreaterThanOrEqual(30);
    expect(fallbackStream?.startTimeOffset).toBeGreaterThanOrEqual(30);
  });

  it('preserves child stream timeline across outer SpeechStream retries', async () => {
    const stt = new RetryTimelineSTT('outer');
    const adapter = new FallbackAdapter({ sttInstances: [stt] });

    const stream = adapter.stream({
      connOptions: { maxRetry: 1, retryIntervalMs: 0, timeoutMs: 10_000 },
    });
    stream.startTimeOffset = 30;
    stream.endInput();

    const events: SpeechEvent[] = [];
    for await (const ev of stream) events.push(ev);

    expect(events.map((e) => e.alternatives?.[0]?.text)).toEqual(['recovered']);
    expect(stt.mainStreams).toHaveLength(2);
    expect(stt.mainStreams[0]?.startTimeOffset).toBeGreaterThanOrEqual(30);
    expect(stt.mainStreams[1]?.startTimeOffset).toBeGreaterThan(
      stt.mainStreams[0]!.startTimeOffset,
    );
  });

  it('preserves child stream timeline across provider retries', async () => {
    const stt = new RetryTimelineSTT('child');
    const adapter = new FallbackAdapter({ sttInstances: [stt] });

    const stream = adapter.stream({
      connOptions: { maxRetry: 0, retryIntervalMs: 0, timeoutMs: 10_000 },
    });
    stream.startTimeOffset = 30;
    stream.endInput();

    const events: SpeechEvent[] = [];
    for await (const ev of stream) events.push(ev);

    expect(events.map((e) => e.alternatives?.[0]?.text)).toEqual(['recovered']);
    expect(stt.mainStreams).toHaveLength(1);
    expect(stt.mainStreams[0]?.runOffsets).toHaveLength(2);
    expect(stt.mainStreams[0]?.runOffsets[0]).toBeGreaterThanOrEqual(30);
    expect(stt.mainStreams[0]!.runOffsets[1]).toBeGreaterThan(stt.mainStreams[0]!.runOffsets[0]!);
  });

  it('stream marks every instance unavailable when all children fail', async () => {
    const err = new APIError('down');
    const a = new FakeSTT({ label: 'a', fakeException: err });
    const b = new FakeSTT({ label: 'b', fakeException: err });
    const adapter = new FallbackAdapter({ sttInstances: [a, b], maxRetryPerSTT: 0 });

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

  it('ends the fallback child when input EOF arrives before failover', async () => {
    // Regression: if endInput() is called on the adapter (input EOF) before
    // the primary errors, the forwarder exits having only seen the primary.
    // The fallback child elected afterwards never receives endInput(), so
    // a provider whose run() drains input hangs forever. Guard: on election
    // after the forwarder has finished, immediately end the child's input.
    // FakeRecognizeStream drains input by default, matching a real provider.
    const primary = new FakeSTT({
      label: 'primary',
      fakeException: new APIError('primary down'),
    });
    const fallback = new FakeSTT({ label: 'fallback', fakeTranscript: 'hello world' });
    const adapter = new FallbackAdapter({
      sttInstances: [primary, fallback],
      maxRetryPerSTT: 0,
    });

    const stream = adapter.stream();
    stream.endInput();

    const events: SpeechEvent[] = [];
    const collect = (async () => {
      for await (const ev of stream) events.push(ev);
    })();

    const timeout = new Promise<'timeout'>((resolve) =>
      setTimeout(() => resolve('timeout'), 1_000),
    );
    const outcome = await Promise.race([collect.then(() => 'ok' as const), timeout]);

    expect(outcome).toBe('ok');
    expect(events.map((e) => e.alternatives?.[0]?.text)).toEqual(['hello world']);
    expect(adapter.status[0]?.available).toBe(false);
    expect(adapter.status[1]?.available).toBe(true);
  });
});

describe('FallbackAdapter dynamic model/provider getters', () => {
  // The OTel `gen_ai.request.model` / `gen_ai.provider.name` attributes on
  // the `user_turn` span are refreshed on every STT event by
  // `audio_recognition.refreshUserTurnSttAttributes`. Without dynamic
  // getters that reflect the active child, those attributes are frozen at
  // the static wrapper labels (`FallbackAdapter` / `livekit`) regardless
  // of which provider actually transcribed, so a mid-turn fallover is
  // invisible in traces.

  class IdentifiedFakeSTT extends FakeSTT {
    private readonly _model: string;
    private readonly _provider: string;
    constructor(opts: { label: string; model: string; provider: string; fakeTranscript?: string }) {
      super({ label: opts.label, fakeTranscript: opts.fakeTranscript });
      this._model = opts.model;
      this._provider = opts.provider;
    }
    override get model(): string {
      return this._model;
    }
    override get provider(): string {
      return this._provider;
    }
  }

  it('returns wrapper defaults before any STT is active', () => {
    const a = new IdentifiedFakeSTT({ label: 'a', model: 'a-model', provider: 'a-provider' });
    const adapter = new FallbackAdapter({ sttInstances: [a] });
    expect(adapter.model).toBe('FallbackAdapter');
    expect(adapter.provider).toBe('livekit');
  });

  it('reflects the active child after a successful recognize()', async () => {
    const primary = new IdentifiedFakeSTT({
      label: 'primary',
      model: 'primary-model',
      provider: 'primary-provider',
      fakeTranscript: 'hello',
    });
    const adapter = new FallbackAdapter({ sttInstances: [primary] });

    await adapter.recognize(emptyAudioFrame());

    expect(adapter.model).toBe('primary-model');
    expect(adapter.provider).toBe('primary-provider');
  });

  it('reflects the fallback child after recognize() falls through', async () => {
    const primary = new IdentifiedFakeSTT({
      label: 'primary',
      model: 'primary-model',
      provider: 'primary-provider',
    });
    // Force primary to throw without touching the IdentifiedFakeSTT constructor
    // surface — updateOptions is the documented runtime knob on FakeSTT.
    primary.updateOptions({ fakeException: new APIConnectionError({ message: 'down' }) });
    const fallback = new IdentifiedFakeSTT({
      label: 'fallback',
      model: 'fallback-model',
      provider: 'fallback-provider',
      fakeTranscript: 'hello',
    });
    const adapter = new FallbackAdapter({ sttInstances: [primary, fallback] });

    await adapter.recognize(emptyAudioFrame());

    expect(adapter.model).toBe('fallback-model');
    expect(adapter.provider).toBe('fallback-provider');
  });

  it('reflects the active child once streaming events flow', async () => {
    const primary = new IdentifiedFakeSTT({
      label: 'primary',
      model: 'primary-model',
      provider: 'primary-provider',
      fakeTranscript: 'hello world',
    });
    const adapter = new FallbackAdapter({ sttInstances: [primary] });

    const stream = adapter.stream();
    stream.endInput();

    const events: SpeechEvent[] = [];
    for await (const ev of stream) events.push(ev);

    expect(events.length).toBeGreaterThan(0);
    expect(adapter.model).toBe('primary-model');
    expect(adapter.provider).toBe('primary-provider');
  });
});
