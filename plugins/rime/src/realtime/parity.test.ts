// SPDX-FileCopyrightText: 2026 LiveKit, Inc.
//
// SPDX-License-Identifier: Apache-2.0
import { initializeLogger, llm, voice } from '@livekit/agents';
import { AudioFrame } from '@livekit/rtc-node';
import { afterEach, expect, it, vi } from 'vitest';
import { RealtimeModel, type RealtimeModelOptions } from './realtime_model.js';
import { PrismPeer, TestAudioOutput } from './test_helpers.js';

initializeLogger({ pretty: false, level: 'silent' });
const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const close of cleanup.splice(0).reverse()) await close();
});
async function setup(options: RealtimeModelOptions = {}) {
  const peer = await new PrismPeer().start();
  cleanup.push(() => peer.close());
  const model = new RealtimeModel({
    apiKey: 'test',
    endpoint: peer.endpoint,
    requestTimeout: 500,
    ...options,
  });
  cleanup.push(() => model.close());
  const session = model.session();
  session.on('error', () => undefined);
  await session.updateInstructions('Test');
  return { peer, model, session };
}
async function collect<T>(source: AsyncIterable<T>): Promise<T[]> {
  const result: T[] = [];
  for await (const item of source) result.push(item);
  return result;
}
function context(...texts: string[]) {
  const ctx = llm.ChatContext.empty();
  for (const content of texts) ctx.addMessage({ role: 'user', content });
  return ctx;
}
async function reply(
  peer: PrismPeer,
  session: ReturnType<RealtimeModel['session']>,
  id = 'reply-1',
) {
  const pending = session.generateReply();
  await vi.waitFor(() => expect(peer.requests.at(-1)?.type).toBe('response.create'));
  peer.reply(peer.requests.at(-1)!, id);
  return pending;
}
it('defaults to shared history, preserves omissions, and rejects conflicting edits', async () => {
  const notices: unknown[] = [];
  const { session, peer } = await setup({ onHistoryUpdate: (n) => notices.push(n) });
  const initial = context('first', 'second');
  await session.updateChatCtx(initial);
  await session.updateChatCtx(context('third'));
  expect(peer.history.map((i) => i.text)).toEqual(['first', 'second', 'third']);
  initial.items[0] = new llm.ChatMessage({
    id: initial.items[0]!.id,
    role: 'user',
    content: 'changed',
  });
  await expect(session.updateChatCtx(initial)).rejects.toMatchObject({
    status: 'rejected',
    recoverable: true,
  });
  expect(notices).toHaveLength(1);
  expect(session.isClosed).toBe(false);
  await session.updateChatCtx(context('fourth'));
  expect(peer.history.map((i) => i.text)).toEqual(['first', 'second', 'third', 'fourth']);
});
it('replaces and repairs active agent context through public helpers', async () => {
  const peer = await new PrismPeer().start();
  cleanup.push(() => peer.close());
  const model = new RealtimeModel({ apiKey: 'test', endpoint: peer.endpoint });
  cleanup.push(() => model.close());
  const session = new voice.AgentSession({
    llm: model,
    vad: null,
    aecWarmupDuration: null,
    turnHandling: { turnDetection: 'realtime_llm' },
  });
  const agent = new voice.Agent({ instructions: 'Test' });
  await session.start({ agent });
  cleanup.push(() => session.close());
  await model.replaceChatCtx(agent, context('old'));
  let creates = 0;
  peer.onRequest = (q) => {
    if (q.type === 'conversation.item.create' && ++creates === 2) {
      peer.fault(q, 'invalid_item');
      return true;
    }
  };
  await expect(model.replaceChatCtx(agent, context('accepted', 'refused'))).rejects.toMatchObject({
    status: 'partial',
    recoverable: true,
    needsReconciliation: false,
  });
  expect(agent.chatCtx.items.filter((i) => i.type === 'message').map((i) => i.textContent)).toEqual(
    ['accepted'],
  );
  const writes = peer.requests.length;
  await model.reconcileChatCtx(agent);
  expect(peer.requests).toHaveLength(writes);
  await model.clearChatCtx(agent);
  expect(peer.history).toEqual([]);
});
it.each(['auto', 'estimated', 'discard'] as const)(
  'uses %s playback without false receipts',
  async (playback) => {
    const { peer, model, session } = await setup({ playback });
    const sink = new TestAudioOutput();
    const output = model.wrapAudioOutput(sink);
    const generation = await reply(peer, session);
    const messages = await collect(generation.messageStream);
    const frames = await collect(messages[0]!.audioStream);
    expect((await collect(messages[0]!.textStream)).join('')).toBe('Hello');
    expect(frames.length > 0).toBe(playback !== 'discard');
    const receipts = () => peer.requests.filter((q) => q.type === 'prism.playback.drained');
    if (playback !== 'discard') expect(receipts()).toEqual([]);
    for (const frame of frames) await output.captureFrame(frame);
    output.flush();
    if (playback === 'estimated') {
      await new Promise((resolve) => setTimeout(resolve, 30));
      expect(receipts()).toEqual([]);
    } else {
      await vi.waitFor(() => expect(receipts()).toHaveLength(1));
      expect(receipts()[0]).toMatchObject({ played_ms: playback === 'discard' ? 0 : 100 });
    }
  },
);
it('keeps server estimates when frames lose identity or playback is interrupted', async () => {
  const { peer, model, session } = await setup();
  const sink = new TestAudioOutput();
  const output = model.wrapAudioOutput(sink);
  const generation = await reply(peer, session);
  const [message] = await collect(generation.messageStream);
  for await (const original of message!.audioStream)
    await output.captureFrame(
      new AudioFrame(
        original.data,
        original.sampleRate,
        original.channels,
        original.samplesPerChannel,
      ),
    );
  output.flush();
  await new Promise((resolve) => setTimeout(resolve, 30));
  expect(peer.requests.some((q) => q.type === 'prism.playback.drained')).toBe(false);
});
it('measures output before resampling to the sink rate', async () => {
  class Sink extends voice.AudioOutput {
    frames: AudioFrame[] = [];
    constructor() {
      super(48000);
    }
    override async captureFrame(frame: AudioFrame) {
      await super.captureFrame(frame);
      this.frames.push(frame);
    }
    override flush() {
      super.flush();
      this.onPlaybackFinished({
        playbackPosition: this.frames.reduce((n, f) => n + f.samplesPerChannel / f.sampleRate, 0),
        interrupted: false,
      });
    }
    override clearBuffer() {}
  }
  const { peer, model, session } = await setup();
  const sink = new Sink();
  const output = model.wrapAudioOutput(sink);
  const generation = await reply(peer, session);
  const [message] = await collect(generation.messageStream);
  for await (const frame of message!.audioStream) await output.captureFrame(frame);
  output.flush();
  await vi.waitFor(() =>
    expect(peer.requests.some((q) => q.type === 'prism.playback.drained')).toBe(true),
  );
  expect(sink.frames.every((f) => f.sampleRate === 48000)).toBe(true);
});
it('emits raw events and one usage record when completion follows local interruption', async () => {
  const { peer, session } = await setup({ playback: 'discard' });
  const raw = vi.fn(),
    metrics = vi.fn();
  session.on('rime_server_event_received', raw);
  session.on('metrics_collected', metrics);
  const pending = session.generateReply();
  await vi.waitFor(() => expect(peer.requests.at(-1)?.type).toBe('response.create'));
  peer.accepted(peer.requests.at(-1)!);
  peer.message();
  peer.audio();
  await pending;
  peer.onRequest = (q) => q.type === 'response.cancel';
  const interrupted = session.interrupt();
  await vi.waitFor(() =>
    expect(peer.requests.some((q) => q.type === 'response.cancel')).toBe(true),
  );
  peer.emit('response.done', {
    response: {
      id: 'reply-1',
      status: 'cancelled',
      usage: { input_tokens: 5, output_tokens: 7, total_tokens: 12, context_window: 32768 },
    },
  });
  await interrupted;
  await vi.waitFor(() => expect(metrics).toHaveBeenCalledOnce());
  expect(metrics.mock.calls[0]![0]).toMatchObject({
    cancelled: true,
    inputTokens: 5,
    outputTokens: 7,
    totalTokens: 12,
  });
  expect(metrics.mock.calls[0]![0].ttftMs).toBeGreaterThanOrEqual(0);
  expect(raw).toHaveBeenCalled();
});
it.each([503, 401])(
  'retries a refused initial connection only for retryable status %i',
  async (status) => {
    const sdk = await import('@rimelabs/sdk');
    const peer = await new PrismPeer().start();
    cleanup.push(() => peer.close());
    const client = new sdk.Rime({ apiKey: 'test' });
    cleanup.push(() => client.close());
    const original = client.realtime.connect.bind(client.realtime);
    const connect = vi
      .spyOn(client.realtime, 'connect')
      .mockRejectedValueOnce(
        status === 503
          ? new sdk.RimeUnavailableError('test', null, { statusCode: status })
          : new sdk.RimeAuthenticationError('test', null, { statusCode: status }),
      )
      .mockImplementationOnce(original);
    const model = new RealtimeModel({
      client,
      endpoint: peer.endpoint,
      connOptions: { maxRetry: 1, timeoutMs: 1000 },
    });
    cleanup.push(() => model.close());
    const session = model.session();
    session.on('error', () => undefined);
    if (status === 503) {
      await session.updateInstructions('Test');
      expect(connect).toHaveBeenCalledTimes(2);
    } else {
      await expect(session.updateInstructions('Test')).rejects.toThrow();
      expect(connect).toHaveBeenCalledOnce();
    }
  },
);
