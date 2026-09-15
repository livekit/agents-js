// SPDX-FileCopyrightText: 2026 LiveKit, Inc.
//
// SPDX-License-Identifier: Apache-2.0
import { AudioFrame } from '@livekit/rtc-node';
import type { EventEmitter } from 'node:events';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { APIError } from '../_exceptions.js';
import { asLanguageCode } from '../language.js';
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

  fail(): void {
    this.completion.reject(new APIError('provider connection ended'));
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
    const [recoveryTask] = adapter.status[0]!.recoveringStreamTasks;

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
    await getStream(secondary, 1);
    owner.close();

    const probe = await getStream(primary, 2);
    expect(oldProbe.isClosed).toBe(true);
    expect(probe.isClosed).toBe(false);
    const pushFrame = vi.spyOn(probe, 'pushFrame');
    const frame = new AudioFrame(new Int16Array(160), 16_000, 1, 160);
    replacement.pushFrame(frame);
    await vi.waitFor(() => expect(pushFrame).toHaveBeenCalledWith(frame));

    probe.emitText('primary recovered in replacement');
    await vi.waitFor(() => expect(adapter.status[0]!.available).toBe(true));
    expect(availability).toEqual([
      { label: 'primary', available: false },
      { label: 'primary', available: true },
    ]);
  });

  it.each(['close', 'recover'] as const)('cleans up concurrent probes on %s', async (action) => {
    adapter.stream();
    (await getStream(primary)).fail();
    const firstProbe = await getStream(primary, 1);
    await getStream(secondary);
    adapter.stream();
    const secondProbe = await getStream(primary, 2);
    await getStream(secondary, 1);

    if (action === 'close') {
      await adapter.close();
    } else {
      firstProbe.emitText('primary recovered');
      secondProbe.emitText('primary also recovered');
    }

    await vi.waitFor(() => expect(primary.listenerCount('error')).toBe(0));
    expect(firstProbe.isClosed).toBe(true);
    expect(secondProbe.isClosed).toBe(true);
    expect(adapter.status[0]!.recoveringStreamTasks.size).toBe(0);
    expect(availability).toEqual([
      { label: 'primary', available: false },
      ...(action === 'recover' ? [{ label: 'primary', available: true }] : []),
    ]);
  });

  it('preserves recovery through an AgentTask handoff', async () => {
    const beginHandoff = new Future<void>();
    const task = AgentTask.create<void>({ instructions: 'question' });
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
