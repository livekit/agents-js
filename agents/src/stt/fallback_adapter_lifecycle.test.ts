// SPDX-FileCopyrightText: 2026 LiveKit, Inc.
//
// SPDX-License-Identifier: Apache-2.0
import { AudioFrame } from '@livekit/rtc-node';
import type { EventEmitter } from 'node:events';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { APIError } from '../_exceptions.js';
import { asLanguageCode } from '../language.js';
import { log } from '../log.js';
import type { APIConnectOptions } from '../types.js';
import { Future, delay } from '../utils.js';
import { Agent, AgentTask } from '../voice/agent.js';
import { AgentSession } from '../voice/agent_session.js';
import { FallbackAdapter } from './fallback_adapter.js';
import { STT, type SpeechEvent, SpeechEventType, SpeechStream } from './stt.js';

class ControlledSTT extends STT {
  streams: ControlledStream[] = [];

  constructor(public label: string) {
    super({ streaming: true, interimResults: true });
  }

  protected async _recognize(): Promise<SpeechEvent> {
    throw new Error('not used');
  }

  stream(options?: { connOptions?: APIConnectOptions }): ControlledStream {
    const stream = new ControlledStream(this, undefined, options?.connOptions);
    this.streams.push(stream);
    return stream;
  }
}

/** Simulates a provider waiting for its final response after input EOF. */
class ControlledStream extends SpeechStream {
  label = 'controlled-stream';
  readonly started = new Future<void>();
  private completion = new Future<void>();

  get isClosed(): boolean {
    return this.closed;
  }

  emitText(text: string): void {
    if (this.closed) return;
    this.queue.put({
      type: SpeechEventType.FINAL_TRANSCRIPT,
      alternatives: [
        { text, language: asLanguageCode('en'), startTime: 0, endTime: 1, confidence: 1 },
      ],
    });
  }

  fail(error: Error = new APIError('provider connection ended')): void {
    this.completion.reject(error);
  }

  finish(): void {
    this.completion.resolve();
  }

  protected async run(): Promise<void> {
    this.started.resolve();
    if (this.abortSignal.aborted) return;
    const onAbort = () => this.completion.resolve();
    this.abortSignal.addEventListener('abort', onAbort, { once: true });
    try {
      await this.completion.await;
    } finally {
      this.abortSignal.removeEventListener('abort', onAbort);
    }
  }
}

async function getStream(provider: ControlledSTT, index = 0): Promise<ControlledStream> {
  await vi.waitFor(() => expect(provider.streams[index]).toBeDefined());
  const stream = provider.streams[index]!;
  await stream.started.await;
  return stream;
}

describe('FallbackSpeechStream lifecycle', () => {
  let primary: ControlledSTT;
  let secondary: ControlledSTT;
  let adapter: FallbackAdapter;
  let streams: SpeechStream[];
  let availability: Array<{ label: string; available: boolean }>;

  beforeEach(() => {
    primary = new ControlledSTT('primary');
    secondary = new ControlledSTT('secondary');
    adapter = new FallbackAdapter({
      sttInstances: [primary, secondary],
      maxRetryPerSTT: 0,
    });
    availability = [];
    (adapter as unknown as EventEmitter).on(
      'stt_availability_changed',
      ({ stt, available }: { stt: STT; available: boolean }) => {
        availability.push({ label: stt.label, available });
      },
    );
    streams = [];
    const createStream = adapter.stream.bind(adapter);
    vi.spyOn(adapter, 'stream').mockImplementation((options) => {
      const stream = createStream(options);
      streams.push(stream);
      return stream;
    });
  });

  afterEach(async () => {
    for (const stream of streams) stream.close();
    for (const provider of [primary, secondary]) {
      for (const stream of provider.streams) stream.close();
    }
    await adapter.close();
    vi.restoreAllMocks();
  });

  it('does not open a provider if closed before its run starts', async () => {
    adapter.stream().close();
    await delay(0);

    expect(primary.streams).toHaveLength(0);
    expect(secondary.streams).toHaveLength(0);
    expect(availability).toEqual([]);
  });

  it('closes an idle child without waiting for another provider event', async () => {
    const stream = adapter.stream();
    const child = await getStream(primary);

    stream.close();
    stream.close();

    expect(child.isClosed).toBe(true);
    await vi.waitFor(() => expect(primary.listenerCount('error')).toBe(0));
    expect(availability).toEqual([]);
  });

  it.each(['transcript', 'error'] as const)(
    'discards an in-flight %s when the parent closes',
    async (event) => {
      const stream = adapter.stream();
      const child = await getStream(primary);
      if (event === 'transcript') child.emitText('late transcript');
      else child.fail();
      stream.close();

      await vi.waitFor(() => expect(primary.listenerCount('error')).toBe(0));
      expect(await stream.next()).toEqual({ done: true, value: undefined });
      expect(availability).toEqual([]);
      expect(adapter.status.map((status) => status.available)).toEqual([true, true]);
      expect(primary.streams).toHaveLength(1);
      expect(secondary.streams).toHaveLength(0);

      const replacement = adapter.stream();
      const replacementChild = await getStream(primary, 1);
      replacementChild.emitText('replacement primary');
      expect((await replacement.next()).value?.alternatives?.[0]?.text).toBe('replacement primary');
    },
  );

  it('ignores a synchronous provider failure during parent closure', async () => {
    const createStream = vi.spyOn(primary, 'stream').mockImplementationOnce(() => {
      stream.close();
      throw new APIError('provider closed during setup');
    });
    const stream = adapter.stream();

    await vi.waitFor(() => expect(createStream).toHaveBeenCalled());
    expect(createStream).toHaveBeenCalledTimes(1);
    expect(secondary.streams).toHaveLength(0);
    expect(availability).toEqual([]);
  });

  it('does not start recovery or fallback if an availability listener closes the parent', async () => {
    const stream = adapter.stream();
    const child = await getStream(primary);
    (adapter as unknown as EventEmitter).on('stt_availability_changed', () => stream.close());

    child.fail();

    await vi.waitFor(() => expect(availability).toEqual([{ label: 'primary', available: false }]));
    expect(primary.streams).toHaveLength(1);
    expect(secondary.streams).toHaveLength(0);
  });

  it('closes an idle recovery probe and settles its task when the parent closes', async () => {
    const stream = adapter.stream();
    const child = await getStream(primary);
    child.fail();
    const probe = await getStream(primary, 1);
    const fallback = await getStream(secondary);
    const recoveryTask = adapter.status[0]!.recoveringStreamTask;

    stream.close();

    expect(probe.isClosed).toBe(true);
    expect(fallback.isClosed).toBe(true);
    await recoveryTask!.result;
    await vi.waitFor(() => expect(secondary.listenerCount('error')).toBe(0));
    expect(primary.listenerCount('error')).toBe(0);
    expect(availability).toEqual([{ label: 'primary', available: false }]);
  });

  it("does not cancel another stream's recovery on clean EOF", async () => {
    adapter.stream();
    const child = await getStream(primary);
    child.fail();
    const probe = await getStream(primary, 1);
    await getStream(secondary);

    const other = adapter.stream();
    const otherChild = await getStream(secondary, 1);
    other.endInput();
    otherChild.finish();
    expect((await other.next()).done).toBe(true);

    probe.emitText('primary recovered');
    await vi.waitFor(() => expect(adapter.status[0]!.available).toBe(true));
    expect(availability).toEqual([
      { label: 'primary', available: false },
      { label: 'primary', available: true },
    ]);
  });

  it('ends a healthy stream after another child from the same provider fails', async () => {
    adapter.stream();
    const failingChild = await getStream(primary);
    const healthy = adapter.stream();
    const healthyChild = await getStream(primary, 1);

    failingChild.fail();
    await getStream(secondary);
    healthy.endInput();
    healthyChild.finish();

    let ended = false;
    const completion = healthy.next().then((event) => {
      ended = !!event.done;
    });
    await vi.waitFor(() => expect(ended).toBe(true));
    await completion;
    expect(secondary.streams).toHaveLength(1);
    expect(availability).toEqual([{ label: 'primary', available: false }]);
  });

  it('keeps recovery alive when another stream with an active probe closes', async () => {
    const owner = adapter.stream();
    (await getStream(primary)).fail();
    const oldProbe = await getStream(primary, 1);
    await getStream(secondary);

    const replacement = adapter.stream();
    const replacementFallback = await getStream(secondary, 1);
    expect(primary.streams).toHaveLength(2);
    const oldPushFrame = vi.spyOn(oldProbe, 'pushFrame');
    const fallbackPushFrame = vi.spyOn(replacementFallback, 'pushFrame');
    const frame = new AudioFrame(new Int16Array(160), 16_000, 1, 160);
    replacement.pushFrame(frame);
    await vi.waitFor(() => expect(fallbackPushFrame).toHaveBeenCalledWith(frame));
    expect(oldPushFrame).not.toHaveBeenCalled();
    owner.close();

    const probe = await getStream(primary, 2);
    expect(oldProbe.isClosed).toBe(true);
    expect(probe.isClosed).toBe(false);
    const pushFrame = vi.spyOn(probe, 'pushFrame');
    replacement.pushFrame(frame);
    await vi.waitFor(() => expect(pushFrame).toHaveBeenCalledWith(frame));

    probe.emitText('primary recovered in replacement');
    await vi.waitFor(() => expect(adapter.status[0]!.available).toBe(true));
    expect(availability).toEqual([
      { label: 'primary', available: false },
      { label: 'primary', available: true },
    ]);
  });

  it.each(['close', 'recover'] as const)('does not start a waiting probe on %s', async (action) => {
    adapter.stream();
    (await getStream(primary)).fail();
    const firstProbe = await getStream(primary, 1);
    await getStream(secondary);
    adapter.stream();
    await getStream(secondary, 1);
    expect(primary.streams).toHaveLength(2);

    if (action === 'close') {
      await adapter.close();
    } else {
      firstProbe.emitText('primary recovered');
    }

    await vi.waitFor(() => expect(primary.listenerCount('error')).toBe(0));
    expect(firstProbe.isClosed).toBe(true);
    expect(primary.streams).toHaveLength(2);
    expect(secondary.streams.every((stream) => !stream.isClosed)).toBe(true);
    expect(adapter.status[0]!.recoveringStreamTask).toBeNull();
    expect(availability).toEqual([
      { label: 'primary', available: false },
      ...(action !== 'close' ? [{ label: 'primary', available: true }] : []),
    ]);
  });

  it('skips a closed waiting stream when transferring recovery', async () => {
    const owner = adapter.stream();
    (await getStream(primary)).fail();
    const oldProbe = await getStream(primary, 1);
    await getStream(secondary);
    const waiting = adapter.stream();
    await getStream(secondary, 1);
    const replacement = adapter.stream();
    await getStream(secondary, 2);
    expect(primary.streams).toHaveLength(2);

    waiting.close();
    owner.close();

    const probe = await getStream(primary, 2);
    expect(oldProbe.isClosed).toBe(true);
    expect(primary.streams).toHaveLength(3);
    const pushFrame = vi.spyOn(probe, 'pushFrame');
    const frame = new AudioFrame(new Int16Array(160), 16_000, 1, 160);
    replacement.pushFrame(frame);
    await vi.waitFor(() => expect(pushFrame).toHaveBeenCalledWith(frame));
  });

  it('continues transcription when a child exits before parent input EOF', async () => {
    const stream = adapter.stream();
    (await getStream(primary)).finish();

    const fallback = await getStream(secondary);
    const pushFrame = vi.spyOn(fallback, 'pushFrame');
    const frame = new AudioFrame(new Int16Array(160), 16_000, 1, 160);
    stream.pushFrame(frame);
    await vi.waitFor(() => expect(pushFrame).toHaveBeenCalledWith(frame));
    fallback.emitText('continued transcription');
    expect((await stream.next()).value?.alternatives?.[0]?.text).toBe('continued transcription');
    expect(availability).toEqual([{ label: 'primary', available: false }]);
  });

  it('keeps forwarding main audio when the recovery probe rejects input', async () => {
    const stream = adapter.stream();
    (await getStream(primary)).fail();
    const probe = await getStream(primary, 1);
    const fallback = await getStream(secondary);
    vi.spyOn(probe, 'pushFrame').mockImplementation(() => {
      throw new Error('probe input closed');
    });
    vi.spyOn(probe, 'flush').mockImplementation(() => {
      throw new Error('probe input closed');
    });
    const pushFrame = vi.spyOn(fallback, 'pushFrame');
    const flush = vi.spyOn(fallback, 'flush');
    const frame = new AudioFrame(new Int16Array(160), 16_000, 1, 160);

    stream.pushFrame(frame);
    stream.flush();

    await vi.waitFor(() => expect(flush).toHaveBeenCalledOnce());
    expect(pushFrame).toHaveBeenCalledWith(frame);
    fallback.emitText('fallback still transcribes');
    expect((await stream.next()).value?.alternatives?.[0]?.text).toBe('fallback still transcribes');
  });

  it('tries the next waiting stream if a replacement probe throws during setup', async () => {
    const owner = adapter.stream();
    (await getStream(primary)).fail();
    await getStream(primary, 1);
    await getStream(secondary);
    adapter.stream();
    await getStream(secondary, 1);
    const replacement = adapter.stream();
    await getStream(secondary, 2);
    vi.spyOn(primary, 'stream').mockImplementationOnce(() => {
      throw new Error('probe setup failed');
    });

    owner.close();

    const probe = await getStream(primary, 2);
    const pushFrame = vi.spyOn(probe, 'pushFrame');
    const frame = new AudioFrame(new Int16Array(160), 16_000, 1, 160);
    replacement.pushFrame(frame);
    await vi.waitFor(() => expect(pushFrame).toHaveBeenCalledWith(frame));
  });

  it('retries the primary directly when every provider is unavailable', async () => {
    for (const status of adapter.status) status.available = false;
    const stream = adapter.stream();
    const child = await getStream(primary);
    expect(secondary.streams).toHaveLength(0);
    expect(adapter.status.every((status) => status.recoveringStreamTask === null)).toBe(true);
    const pushFrame = vi.spyOn(child, 'pushFrame');
    const frame = new AudioFrame(new Int16Array(160), 16_000, 1, 160);

    stream.pushFrame(frame);
    await vi.waitFor(() => expect(pushFrame).toHaveBeenCalledWith(frame));
    child.emitText('direct retry succeeded');
    stream.endInput();
    child.finish();

    expect((await stream.next()).value?.alternatives?.[0]?.text).toBe('direct retry succeeded');
    expect((await stream.next()).done).toBe(true);
    expect(availability).toEqual([]);
    expect(adapter.status.map((status) => status.available)).toEqual([false, false]);
  });

  it('retries the unavailable secondary after the unavailable primary fails', async () => {
    for (const status of adapter.status) status.available = false;
    const stream = adapter.stream();
    (await getStream(primary)).fail();
    const probe = await getStream(primary, 1);
    const fallback = await getStream(secondary);
    const pushFrame = vi.spyOn(fallback, 'pushFrame');
    const frame = new AudioFrame(new Int16Array(160), 16_000, 1, 160);
    stream.pushFrame(frame);
    await vi.waitFor(() => expect(pushFrame).toHaveBeenCalledWith(frame));

    probe.emitText('probe transcript');
    await vi.waitFor(() => expect(adapter.status[0]!.available).toBe(true));
    fallback.emitText('secondary transcript');
    stream.endInput();
    fallback.finish();

    const texts: string[] = [];
    for await (const event of stream) texts.push(event.alternatives![0].text);
    expect(texts).toEqual(['secondary transcript']);
    expect(availability).toEqual([{ label: 'primary', available: true }]);
    expect(probe.isClosed).toBe(true);
  });

  it('retries normally alongside an existing probe without creating another probe', async () => {
    const owner = adapter.stream();
    (await getStream(primary)).fail();
    const firstProbe = await getStream(primary, 1);
    await getStream(secondary);
    const recoveryTask = adapter.status[0]!.recoveringStreamTask;
    adapter.status[1]!.available = false;

    const retry = adapter.stream();
    const retryChild = await getStream(primary, 2);
    expect(adapter.status[0]!.recoveringStreamTask).toBe(recoveryTask);
    expect(firstProbe.isClosed).toBe(false);
    retryChild.fail();
    await getStream(secondary, 1);
    expect(primary.streams).toHaveLength(3);
    expect(adapter.status[0]!.recoveringStreamTask).toBe(recoveryTask);

    owner.close();

    const replacementProbe = await getStream(primary, 3);
    expect(firstProbe.isClosed).toBe(true);
    const pushFrame = vi.spyOn(replacementProbe, 'pushFrame');
    const frame = new AudioFrame(new Int16Array(160), 16_000, 1, 160);
    retry.pushFrame(frame);
    await vi.waitFor(() => expect(pushFrame).toHaveBeenCalledWith(frame));
  });

  it.each([APIError, Error])(
    'falls back after an input-ended child fails with %s',
    async (ErrorType) => {
      const stream = adapter.stream();
      const child = await getStream(primary);
      stream.endInput();
      child.fail(new ErrorType('terminal failure'));

      const fallback = await getStream(secondary);
      fallback.emitText('final fallback transcript');
      fallback.finish();

      expect(child._failed).toBe(true);
      expect((await stream.next()).value?.alternatives?.[0]?.text).toBe(
        'final fallback transcript',
      );
      expect((await stream.next()).done).toBe(true);
    },
  );

  it('ignores a recognize recovery result after adapter shutdown', async () => {
    const recovery = new Future<SpeechEvent>();
    const result: SpeechEvent = {
      type: SpeechEventType.FINAL_TRANSCRIPT,
      alternatives: [
        {
          text: 'recognized',
          language: asLanguageCode('en'),
          startTime: 0,
          endTime: 1,
          confidence: 1,
        },
      ],
    };
    vi.spyOn(primary, 'recognize')
      .mockRejectedValueOnce(new APIError('primary failed'))
      .mockImplementationOnce(() => recovery.await);
    vi.spyOn(secondary, 'recognize').mockResolvedValue(result);
    await adapter.recognize(new AudioFrame(new Int16Array(160), 16_000, 1, 160));
    const task = adapter.status[0]!.recoveringRecognizeTask!;
    try {
      await adapter.close();
      expect(task.done).toBe(false);
    } finally {
      recovery.resolve(result);
      await task.result;
    }

    expect(adapter.status[0]!.available).toBe(false);
    expect(availability).toEqual([{ label: 'primary', available: false }]);
    await vi.waitFor(() => expect(adapter.status[0]!.recoveringRecognizeTask).toBeNull());
  });

  it('closes recovery probes when every unavailable provider fails its normal retry', async () => {
    for (const status of adapter.status) status.available = false;
    adapter.on('error', () => {});
    const stream = adapter.stream();
    (await getStream(primary)).fail();
    const primaryProbe = await getStream(primary, 1);
    const fallback = await getStream(secondary);

    fallback.fail();

    expect((await stream.next()).done).toBe(true);
    await vi.waitFor(() =>
      expect(adapter.status.every((status) => status.recoveringStreamTask === null)).toBe(true),
    );
    expect(primaryProbe.isClosed).toBe(true);
    expect(primary.streams).toHaveLength(2);
    expect(secondary.streams).toHaveLength(2);
    expect(secondary.streams.every((child) => child.isClosed)).toBe(true);
    expect(availability).toEqual([]);
  });

  it.each([
    ['APIError', APIError],
    ['Error', Error],
  ] as const)('logs safe metadata for a %s provider error', async (_name, ErrorType) => {
    const error = new ErrorType('secret provider response');
    error.cause = new Error('secret credentials');
    const warn = vi.spyOn(log(), 'warn');
    vi.spyOn(primary, 'stream').mockImplementation(() => {
      throw error;
    });

    adapter.stream();
    await getStream(secondary);

    expect(warn).toHaveBeenCalledWith(
      { stt: 'primary', errorType: ErrorType.name },
      'STT failed, switching to next provider',
    );
    for (const [attributes] of warn.mock.calls) {
      expect(attributes).not.toHaveProperty('err');
      expect(attributes).not.toHaveProperty('error');
    }
  });

  it('transfers the recovery probe through an AgentTask handoff', async () => {
    const beginHandoff = new Future<void>();
    // a custom sttNode makes the handoff recreate the STT pipeline (the default node is
    // reused across a handoff), which is the transfer this test exercises
    const task = AgentTask.create<void>({
      instructions: 'question',
      sttNode: (ctx, audio, modelSettings) =>
        Agent.default.sttNode(ctx.agent, audio, modelSettings),
    });
    const parent = Agent.create({
      instructions: 'parent',
      onEnter: async () => {
        await beginHandoff.await;
        await task.run();
      },
    });
    const session = new AgentSession({
      stt: adapter,
      vad: null,
      turnDetection: 'manual',
      turnHandling: { interruption: { enabled: false } },
    });
    try {
      await session.start({ agent: parent });
      (await getStream(primary)).fail();
      const oldProbe = await getStream(primary, 1);
      await getStream(secondary);

      beginHandoff.resolve();
      await getStream(secondary, 1);
      const probe = await getStream(primary, 2);

      expect(session.currentAgent).toBe(task);
      expect(oldProbe.isClosed).toBe(true);
      expect(primary.streams.filter((stream) => !stream.isClosed)).toEqual([probe]);
      probe.emitText('primary recovered in task');
      await vi.waitFor(() => expect(adapter.status[0]!.available).toBe(true));
      expect(availability).toEqual([
        { label: 'primary', available: false },
        { label: 'primary', available: true },
      ]);
    } finally {
      beginHandoff.resolve();
      if (!task.done) task.complete(undefined);
      await session.close();
    }
  });

  it('preserves recovery through an AgentTask handoff', async () => {
    const beginHandoff = new Future<void>();
    // a custom sttNode makes the handoff recreate the STT pipeline (the default node is
    // reused across a handoff), which is the transfer this test exercises
    const task = AgentTask.create<void>({
      instructions: 'question',
      sttNode: (ctx, audio, modelSettings) =>
        Agent.default.sttNode(ctx.agent, audio, modelSettings),
    });
    const parent = Agent.create({
      instructions: 'parent',
      onEnter: async () => {
        await beginHandoff.await;
        await task.run();
      },
    });
    const session = new AgentSession({
      stt: adapter,
      vad: null,
      turnDetection: 'manual',
      turnHandling: { interruption: { enabled: false } },
    });
    try {
      await session.start({ agent: parent });
      const oldChild = await getStream(primary);
      beginHandoff.resolve();
      const taskChild = await getStream(primary, 1);
      expect(session.currentAgent).toBe(task);
      expect(adapter.stream).toHaveBeenCalledTimes(2);

      taskChild.fail();
      const probe = await getStream(primary, 2);
      await getStream(secondary);
      oldChild.emitText('late parent transcript');
      await delay(0);
      probe.emitText('primary recovered in task');

      await vi.waitFor(() => expect(adapter.status[0]!.available).toBe(true));
      expect(oldChild.isClosed).toBe(true);
      expect(availability).toEqual([
        { label: 'primary', available: false },
        { label: 'primary', available: true },
      ]);
    } finally {
      beginHandoff.resolve();
      if (!task.done) task.complete(undefined);
      await session.close();
    }
  });
});
