// SPDX-FileCopyrightText: 2026 LiveKit, Inc.
//
// SPDX-License-Identifier: Apache-2.0
import { initializeLogger, llm, voice } from '@livekit/agents';
import { AudioFrame } from '@livekit/rtc-node';
import { ReadableStream } from 'node:stream/web';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { RealtimeModel } from './realtime_model.js';
import { PrismPeer, TestAudioOutput } from './test_helpers.js';

initializeLogger({ pretty: false, level: 'silent' });
async function collect<T>(source: AsyncIterable<T>): Promise<T[]> {
  const result: T[] = [];
  for await (const item of source) result.push(item);
  return result;
}
const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const close of cleanup.splice(0).reverse()) await close();
});
async function setup(timeouts: { requestTimeout?: number; readyTimeout?: number } = {}) {
  const peer = await new PrismPeer().start();
  cleanup.push(() => peer.close());
  const model = new RealtimeModel({
    apiKey: 'test',
    endpoint: peer.endpoint,
    requestTimeout: 300,
    readyTimeout: 500,
    ...timeouts,
  });
  cleanup.push(() => model.close());
  const session = model.session();
  const errors: llm.RealtimeModelError[] = [];
  session.on('error', (error) => errors.push(error));
  await session.updateInstructions('Test');
  return { peer, model, session, errors };
}
async function request(peer: PrismPeer, count = 1) {
  await vi.waitFor(() =>
    expect(peer.requests.filter((value) => value.type === 'response.create')).toHaveLength(count),
  );
  return peer.requests.filter((value) => value.type === 'response.create')[count - 1]!;
}

describe('Prism SDK adapter', () => {
  it('preserves deleted assistant history when closing the session', async () => {
    const { peer, session } = await setup();
    const pending = session.generateReply();
    peer.reply(await request(peer));
    const generation = await pending;
    await collect(generation.messageStream);
    expect(session.chatCtx.items.some((item) => item.type === 'message')).toBe(true);
    await session.updateChatCtx(llm.ChatContext.empty());
    expect(session.chatCtx.items).toEqual([]);
    await session.close();
    expect(session.chatCtx.items).toEqual([]);
  });

  it('retains accepted settings when a later metadata update is refused', async () => {
    const { peer, model, session } = await setup();
    peer.onRequest = (request) => {
      if (request.type === 'session.update' && request.session?.prism_response_metadata) {
        peer.fault(request, 'invalid_metadata');
        return true;
      }
    };
    await expect(
      model.updateSession({ voice: 'accepted-voice', responseMetadata: { step: '2' } }),
    ).rejects.toThrow();
    expect(model.sessionInfo?.voice).toBe('accepted-voice');
    await session.close();
    const before = peer.requests.length;
    const replacement = model.session();
    await replacement.updateInstructions('Fresh conversation');
    expect(
      peer.requests.slice(before).find((request) => request.type === 'session.update')?.session
        ?.voice,
    ).toBe('accepted-voice');
  });

  it('persists the settings snapshot instead of later caller mutations', async () => {
    const { peer, model, session } = await setup();
    const options = { voice: 'requested-voice' };
    const update = model.updateSession(options);
    options.voice = 'mutated-after-call';
    await update;
    expect(model.sessionInfo?.voice).toBe('requested-voice');
    await session.close();
    const before = peer.requests.length;
    await model.session().updateInstructions('Fresh conversation');
    expect(
      peer.requests.slice(before).find((request) => request.type === 'session.update')?.session
        ?.voice,
    ).toBe('requested-voice');
  });
  it.each(['refused', 'timeout', 'close'] as const)(
    'settles %s connection setup and closes its socket',
    async (mode) => {
      const peer = await new PrismPeer().start();
      cleanup.push(() => peer.close());
      peer.autoInitialize = false;
      if (mode === 'refused')
        peer.onRequest = (q) => {
          peer.fault(q, 'invalid_settings');
          return true;
        };
      const model = new RealtimeModel({
        apiKey: 'test',
        endpoint: peer.endpoint,
        connectTimeout: 150,
        requestTimeout: 100,
      });
      cleanup.push(() => model.close());
      const session = model.session();
      const pending = session.updateInstructions('Test');
      const rejected = expect(pending).rejects.toThrow();
      await vi.waitFor(() => expect(peer.requests.length).toBeGreaterThan(0));
      if (mode === 'close') await session.close();
      await rejected;
      await model.close();
      await vi.waitFor(() => expect(peer.socket.readyState).toBe(3));
    },
  );
  it('does not submit a reply aborted during tool removal', async () => {
    const { peer, session, errors } = await setup();
    const abort = new AbortController();
    session.updateOptions({ toolChoice: 'none' });
    session.once('session_updated', () => abort.abort());
    await expect(session.generateReply(undefined, { signal: abort.signal })).rejects.toThrow();
    expect(peer.requests.filter((q) => q.type === 'response.create')).toEqual([]);
    expect(errors).toEqual([]);
    session.updateOptions({ toolChoice: 'auto' });
    const next = session.generateReply();
    peer.reply(await request(peer));
    await next;
  });
  it('submits multiple tool results without holding admission behind history updates', async () => {
    const { peer, session } = await setup();
    const first = session.generateReply();
    peer.accepted(await request(peer));
    peer.tool('reply-1', 'one');
    peer.tool('reply-1', 'two');
    peer.ended();
    const created = await first;
    const calls = await collect(created.functionStream);
    expect(calls).toHaveLength(2);
    const ctx = session.chatCtx;
    for (const call of calls)
      ctx.items.push(
        new llm.FunctionCallOutput({ callId: call.callId, output: '42', isError: false }),
      );
    await session.updateChatCtx(ctx);
    const next = session.generateReply();
    const q = await request(peer, 2);
    expect(q.response?.metadata?.prism_parent_response_id).toBe('reply-1');
    peer.reply(q, 'next');
    await next;
    expect(peer.requests.filter((q) => q.item?.type === 'function_call_output')).toHaveLength(2);
  });
  it.each(['empty', 'text'] as const)('closes %s response streams', async (mode) => {
    const { peer, session } = await setup();
    const pending = session.generateReply();
    const q = await request(peer);
    if (mode === 'empty') {
      peer.accepted(q);
      peer.ended();
    } else peer.reply(q, 'reply-1', false);
    const generation = await pending;
    const messages = await collect(generation.messageStream);
    expect(messages).toHaveLength(mode === 'empty' ? 0 : 1);
    if (messages[0]) {
      expect(await collect(messages[0].audioStream)).toEqual([]);
      expect(await collect(messages[0].textStream)).toEqual(['Hello']);
    }
    expect(await collect(generation.functionStream)).toEqual([]);
  });
  it('keeps the prior tool policy until tool removal is acknowledged', async () => {
    const { peer, session, errors } = await setup();
    let emitted = false;
    peer.onRequest = (q) => {
      if (
        !emitted &&
        q.type === 'session.update' &&
        Array.isArray(q.session?.tools) &&
        q.session.tools.length === 0
      ) {
        emitted = true;
        peer.accepted(undefined, 'old-policy', peer.revision);
        peer.tool('old-policy');
        peer.ended('old-policy');
      }
    };
    session.updateOptions({ toolChoice: 'none' });
    const pending = session.generateReply();
    void pending.catch(() => undefined);
    peer.reply(await request(peer));
    await pending;
    expect(errors).toEqual([]);
    expect(session.chatCtx.items.some((item) => item.type === 'function_call')).toBe(true);
  });
  it('preserves a burst of small input frames released after handoff', async () => {
    const { peer, session, errors } = await setup();
    session.setInputAudioStream(
      new ReadableStream({
        start(controller) {
          for (let i = 0; i < 200; i++)
            controller.enqueue(new AudioFrame(new Int16Array(160).fill(i + 1), 16000, 1, 160));
          controller.close();
        },
      }),
    );
    await vi.waitFor(() => {
      const pcm = Buffer.concat(
        peer.requests
          .filter((q) => q.type === 'input_audio_buffer.append')
          .map((q) => Buffer.from(q.audio!, 'base64')),
      );
      expect(errors).toEqual([]);
      expect(pcm.length).toBe(64000);
      for (let i = 0; i < 200; i++) expect(pcm.readInt16LE(i * 320)).toBe(i + 1);
    });
  });
  it('keeps the session usable after an aborted admission', async () => {
    const { peer, session, errors } = await setup();
    const abort = new AbortController();
    const pending = session.generateReply(undefined, { signal: abort.signal });
    const rejected = expect(pending).rejects.toThrow();
    const q = await request(peer);
    abort.abort();
    await rejected;
    peer.accepted(q);
    await vi.waitFor(() =>
      expect(peer.requests.some((value) => value.type === 'response.cancel')).toBe(true),
    );
    const next = session.generateReply();
    peer.reply(await request(peer, 2), 'next');
    await next;
    expect(errors.filter((value) => !value.recoverable)).toEqual([]);
  });
  it('rejects a late tool call from a suppressed settings revision', async () => {
    const { peer, session, errors } = await setup();
    session.updateOptions({ toolChoice: 'none' });
    const pending = session.generateReply();
    const q = await request(peer);
    const revision = peer.revision;
    peer.accepted(q);
    peer.ended();
    await pending;
    peer.accepted(undefined, 'late', revision);
    peer.tool('late');
    await vi.waitFor(() => expect(errors.filter((value) => !value.recoverable)).toHaveLength(1));
    expect(session.chatCtx.items.some((item) => item.type === 'function_call')).toBe(false);
  });
  it.each(['acceptance', 'cancellation'] as const)(
    'fails on restoration refusal after %s and keeps provider text out of errors',
    async (outcome) => {
      const { peer, session, errors } = await setup();
      await session.updateTools(
        new llm.ToolContext({
          lookup: llm.tool({ description: 'Lookup', execute: async () => '42' }),
        }),
      );
      session.updateOptions({ toolChoice: 'none' });
      const controller = new AbortController();
      const pending = session.generateReply(undefined, { signal: controller.signal });
      const rejected = expect(pending).rejects.toThrow('invalid_settings');
      const q = await request(peer);
      peer.onRequest = (value) => {
        if (value.type === 'session.update') {
          peer.fault(value, 'invalid_settings');
          return true;
        }
      };
      if (outcome === 'cancellation') controller.abort();
      else peer.accepted(q);
      await rejected;
      await session.close();
      expect(errors.filter((value) => !value.recoverable)).toHaveLength(1);
      expect(errors[0]!.error.message).not.toContain('secret');
    },
  );
  it('does not let stale truncation cancel a newer reply', async () => {
    const { peer, session, errors } = await setup();
    const first = session.generateReply();
    peer.reply(await request(peer));
    await first;
    const next = session.generateReply();
    peer.accepted(await request(peer, 2), 'next');
    await next;
    peer.onRequest = (value) => {
      if (value.type === 'conversation.item.truncate') {
        peer.fault(value, 'truncate_not_current');
        return true;
      }
    };
    await session.truncate({ messageId: 'message-reply-1', audioEndMs: 20 });
    expect(peer.requests.filter((value) => value.type === 'response.cancel')).toEqual([]);
    peer.ended('next');
    expect(errors).toEqual([]);
  });
  it('loads acknowledged settings and replaces a closed session', async () => {
    const { model, session } = await setup();
    expect(model.sessionInfo).toMatchObject({ model: 'prism', voice: 'test' });
    expect(() => model.session()).toThrow('previous');
    await Promise.all([session.close(), session.close()]);
    const next = model.session();
    await next.updateInstructions('Fresh');
    expect(next.chatCtx.items).toEqual([]);
  });
  it('keeps a borrowed client open and closes during connection', async () => {
    const { Rime } = await import('@rimelabs/sdk');
    const peer = await new PrismPeer().start();
    cleanup.push(() => peer.close());
    const client = new Rime({ apiKey: 'test' });
    cleanup.push(() => client.close());
    const close = vi.spyOn(client, 'close');
    const model = new RealtimeModel({ client, endpoint: peer.endpoint });
    const session = model.session();
    await session.close();
    await model.close();
    expect(close).not.toHaveBeenCalled();
    const direct = await client.realtime.connect({ endpoint: peer.endpoint });
    await direct.close();
  });
  it('rejects unsupported operations and unsafe endpoints', async () => {
    expect(() => new RealtimeModel({ endpoint: 'ws://example.com' })).toThrow('secure');
    expect(() => new RealtimeModel({ endpoint: 'wss://example.com' })).toThrow('trusted');
    expect(() => new RealtimeModel().session({ turnDetectionDisabled: true })).toThrow(
      'server turn detection',
    );
    const { session } = await setup();
    await expect(session.commitAudio()).rejects.toThrow('server turn detection');
    expect(() => session.updateOptions({ toolChoice: 'required' })).toThrow('auto or none');
  });
  it('routes requested and automatic generations once and produces PCM audio', async () => {
    const { peer, session } = await setup();
    const automatic = vi.fn();
    session.on('generation_created', automatic);
    const pending = session.generateReply();
    peer.reply(await request(peer));
    const generation = await pending;
    expect(automatic).not.toHaveBeenCalled();
    const messages = await collect(generation.messageStream);
    expect(await collect(messages[0]!.textStream)).toEqual(['Hello']);
    const audio = await collect(messages[0]!.audioStream);
    expect(audio[0]!.data.some((value) => value !== 0)).toBe(true);
    expect(generation).toMatchObject({ responseId: 'reply-1', userInitiated: true });
    peer.accepted(undefined, 'auto');
    peer.ended('auto');
    await vi.waitFor(() => expect(automatic).toHaveBeenCalledOnce());
  });
  it('does not block updates behind unconsumed output', async () => {
    const { peer, session } = await setup();
    const pending = session.generateReply();
    const q = await request(peer);
    peer.accepted(q);
    peer.message();
    for (let i = 0; i < 100; i++) peer.audio();
    await pending;
    await session.updateInstructions('Still responsive');
    await session.interrupt();
    expect(peer.requests.some((value) => value.type === 'response.cancel')).toBe(true);
  });
  it('fails once on output overflow and releases the session', async () => {
    const { peer, session, errors } = await setup();
    const pending = session.generateReply();
    peer.accepted(await request(peer));
    peer.message();
    await pending;
    for (let i = 0; i < 260; i++) peer.audio();
    await vi.waitFor(() => expect(errors.filter((value) => !value.recoverable)).toHaveLength(1));
    await session.close();
    expect(session.isClosed).toBe(true);
  });
  it('bounds input before connection and closes without unhandled work', async () => {
    const peer = await new PrismPeer().start();
    cleanup.push(() => peer.close());
    peer.autoInitialize = false;
    const model = new RealtimeModel({ endpoint: peer.endpoint, apiKey: 'test' });
    cleanup.push(() => model.close());
    const session = model.session();
    const errors: unknown[] = [];
    session.on('error', (error) => errors.push(error));
    for (let i = 0; i < 101; i++)
      session.pushAudio(new AudioFrame(new Int16Array(1600), 16000, 1, 1600));
    await session.close();
    expect(errors).toHaveLength(1);
  });
  it.each([8000, 16000, 24000, 48000, 44100])(
    'copies and converts %i Hz input with clear ordering',
    async (rate) => {
      const { peer, session } = await setup();
      const data = new Int16Array(132340);
      data.fill(1000);
      session.pushAudio(new AudioFrame(data.subarray(20, 132320), rate, 3, 44100));
      data.fill(0);
      const clear = session.clearAudio();
      session.pushAudio(new AudioFrame(new Int16Array(320).fill(2000), 16000, 1, 320));
      await clear;
      await vi.waitFor(() => expect(peer.requests.at(-1)?.type).toBe('input_audio_buffer.append'));
      const input = peer.requests.filter((value) => value.type.startsWith('input_audio_buffer.'));
      const clearIndex = input.findIndex((value) => value.type === 'input_audio_buffer.clear');
      expect(clearIndex).toBeGreaterThan(0);
      expect(
        input.slice(clearIndex + 1).every((value) => value.type === 'input_audio_buffer.append'),
      ).toBe(true);
      expect(Buffer.from(input.at(-1)!.audio!, 'base64').readInt16LE()).toBe(2000);
      expect(Buffer.from(input[0]!.audio!, 'base64').some((value) => value !== 0)).toBe(true);
    },
  );
  it('submits each tool result once and continues the owning response', async () => {
    const { peer, session } = await setup();
    const pending = session.generateReply();
    peer.accepted(await request(peer));
    peer.tool();
    peer.ended();
    const generation = await pending;
    const [call] = await collect(generation.functionStream);
    const ctx = session.chatCtx;
    ctx.items.push(
      new llm.FunctionCallOutput({ callId: call!.callId, output: '42', isError: false }),
    );
    await session.updateChatCtx(ctx);
    await session.updateChatCtx(ctx);
    expect(peer.requests.filter((q) => q.item?.type === 'function_call_output')).toHaveLength(1);
    const next = session.generateReply();
    const q = await request(peer, 2);
    expect(q.response?.metadata?.prism_parent_response_id).toBe('reply-1');
    peer.reply(q, 'reply-2');
    await next;
  });
  it('cancels a tool-free reply before readiness without submitting it', async () => {
    const { peer, session, errors } = await setup({ readyTimeout: 5000 });
    await session.updateTools(
      new llm.ToolContext({
        lookup: llm.tool({ description: 'Lookup', execute: async () => '42' }),
      }),
    );
    peer.autoReady = false;
    const speechStarted = vi.fn();
    session.on('input_speech_started', speechStarted);
    peer.emit('input_audio_buffer.speech_started', { item_id: 'speech-1', audio_start_ms: 0 });
    await vi.waitFor(() => expect(speechStarted).toHaveBeenCalledOnce());
    session.updateOptions({ toolChoice: 'none' });
    const controller = new AbortController();
    const pending = session.generateReply(undefined, { signal: controller.signal });
    const rejected = expect(pending).rejects.toThrow();
    await vi.waitFor(() => expect(peer.settings.tools).toEqual([]));
    controller.abort();
    const update = session.updateInstructions('After cancellation');
    await vi.waitFor(() => expect(peer.settings.instructions).toBe('After cancellation'));
    await rejected;
    await update;
    expect(peer.settings.tools).toHaveLength(1);
    expect(peer.requests.some((q) => q.type === 'response.create')).toBe(false);
    session.updateOptions({ toolChoice: 'auto' });
    peer.ready();
    const next = session.generateReply();
    peer.reply(await request(peer), 'next');
    await next;
    expect(errors).toEqual([]);
  });
  it.each(['suppressed', 'restored'] as const)(
    'restores tools on cancellation and discards a late reply with %s settings',
    async (settings) => {
      const { peer, session, errors } = await setup({ requestTimeout: 5000 });
      await session.updateTools(
        new llm.ToolContext({
          lookup: llm.tool({ description: 'Lookup', execute: async () => '42' }),
        }),
      );
      session.updateOptions({ toolChoice: 'none' });
      const controller = new AbortController();
      const pending = session.generateReply(undefined, { signal: controller.signal });
      const rejected = expect(pending).rejects.toThrow();
      session.updateOptions({ toolChoice: 'auto' });
      const q = await request(peer);
      const suppressedRevision = peer.revision;
      expect(peer.settings.tools).toEqual([]);
      controller.abort();
      const update = session.updateInstructions('After cancellation');
      await vi.waitFor(() => expect(peer.settings.instructions).toBe('After cancellation'));
      await rejected;
      await update;
      expect(peer.settings.tools).toHaveLength(1);
      const automatic = vi.fn();
      session.on('generation_created', automatic);
      peer.accepted(undefined, 'automatic');
      peer.message('automatic');
      peer.audio('automatic');
      await vi.waitFor(() => expect(automatic).toHaveBeenCalledOnce());
      peer.accepted(q, 'late', settings === 'suppressed' ? suppressedRevision : peer.revision);
      // A late acceptance can include output before the cancellation roundtrip finishes.
      peer.message('late');
      peer.text('Cancelled output', 'late');
      peer.audio('late');
      if (settings === 'restored') peer.tool('late', 'cancelled-call');
      await vi.waitFor(() =>
        expect(
          peer.requests.some((q) => q.type === 'response.cancel' && q.response_id === 'late'),
        ).toBe(true),
      );
      expect(automatic).toHaveBeenCalledOnce();
      expect(session.chatCtx.items.some((item) => item.type === 'function_call')).toBe(false);
      expect(
        session.chatCtx.items.some(
          (item) => item.type === 'message' && item.textContent === 'Cancelled output',
        ),
      ).toBe(false);
      await session.interrupt();
      expect(
        peer.requests.some((q) => q.type === 'response.cancel' && q.response_id === 'automatic'),
      ).toBe(true);
      peer.ready();
      const next = session.generateReply();
      peer.reply(await request(peer, 2), 'next');
      await next;
      expect(errors).toEqual([]);
    },
  );
  it('reports failures after response creation', async () => {
    const { peer, session, errors } = await setup();
    const pending = session.generateReply();
    peer.accepted(await request(peer));
    await pending;
    peer.ended('reply-1', 'failed');
    await vi.waitFor(() => expect(errors).toHaveLength(1));
  });
  it('settles pending replies on disconnect', async () => {
    const { peer, session, errors } = await setup();
    const pending = session.generateReply();
    const rejected = expect(pending).rejects.toThrow();
    await request(peer);
    peer.socket.terminate();
    await rejected;
    await session.close();
    expect(errors.filter((value) => !value.recoverable)).toHaveLength(1);
  });
});

describe('standard AgentSession', () => {
  async function start(maxToolSteps = 3) {
    const peer = await new PrismPeer().start();
    cleanup.push(() => peer.close());
    const model = new RealtimeModel({
      apiKey: 'test',
      endpoint: peer.endpoint,
      requestTimeout: 500,
    });
    cleanup.push(() => model.close());
    const session = new voice.AgentSession({
      llm: model,
      vad: null,
      maxToolSteps,
      aecWarmupDuration: null,
      turnHandling: { turnDetection: 'realtime_llm' },
    });
    const output = new TestAudioOutput();
    session.output.audio = output;
    const execute = vi.fn(async () => '42');
    const createSession = vi.spyOn(model, 'session');
    await session.start({
      agent: new voice.Agent({
        instructions: 'Test',
        tools: { lookup: llm.tool({ description: 'Lookup', execute }) },
      }),
    });
    cleanup.push(() => session.close());
    const realtime = createSession.mock.results[0]!.value as ReturnType<RealtimeModel['session']>;
    return { peer, model, session, output, execute, realtime };
  }
  it('uses history for typed input and respects maxToolSteps', async () => {
    const { peer, session, execute, output } = await start(1);
    let count = 0;
    peer.onRequest = (q) => {
      if (q.type !== 'response.create') return;
      const id = `reply-${++count}`;
      peer.accepted(q, id);
      if ((peer.settings.tools as unknown[])?.length) peer.tool(id, `call-${count}`);
      else {
        peer.message(id);
        peer.text('Done', id);
        peer.audio(id);
      }
      peer.ended(id);
      return true;
    };
    const handle = session.generateReply({ userInput: 'Check my order' });
    await handle.waitForPlayout();
    expect(execute).toHaveBeenCalled();
    expect(count).toBeLessThanOrEqual(3);
    expect(peer.requests.some((q) => q.item?.text === 'Check my order')).toBe(true);
    expect(output.frames.length).toBeGreaterThan(0);
  });
  it.each(['session', 'handle'] as const)(
    'cancels active provider output using %s interruption',
    async (mode) => {
      const { peer, session, output } = await start();
      const handle = session.generateReply();
      peer.accepted(await request(peer));
      peer.message();
      peer.text();
      peer.audio();
      await vi.waitFor(() => expect(output.frames.length).toBeGreaterThan(0));
      if (mode === 'session') session.interrupt();
      else handle.interrupt();
      await vi.waitFor(() =>
        expect(peer.requests.some((q) => q.type === 'response.cancel')).toBe(true),
      );
      await handle.waitForPlayout();
      const next = session.generateReply();
      peer.reply(await request(peer, 2), 'reply-2');
      await next.waitForPlayout();
    },
  );
  it.each(['session', 'handle'] as const)(
    'checks %s interruption before the first message',
    async (mode) => {
      const { peer, session } = await start();
      const handle = session.generateReply();
      peer.accepted(await request(peer));
      // Wait until generation creation has reached LiveKit, with no message/audio to truncate.
      await new Promise((resolve) => setTimeout(resolve, 30));
      if (mode === 'session') session.interrupt();
      else handle.interrupt();
      if (mode === 'session') {
        await vi.waitFor(() =>
          expect(peer.requests.some((q) => q.type === 'response.cancel')).toBe(true),
        );
      } else {
        await new Promise((resolve) => setTimeout(resolve, 100));
        // Exact core limitation: there is no cancellation callback while waiting for the first message.
        expect(peer.requests.some((q) => q.type === 'response.cancel')).toBe(false);
        peer.ended();
      }
      await handle.waitForPlayout();
    },
  );
  it.each(['session', 'handle'] as const)(
    'truncates queued audio after generation ends using %s',
    async (mode) => {
      const { peer, session, output, realtime } = await start();
      output.hold = true;
      const handle = session.generateReply();
      peer.reply(await request(peer));
      await vi.waitFor(() => expect(output.frames.length).toBeGreaterThan(0));
      const truncated = vi.fn();
      realtime.on('item_truncated', truncated);
      peer.emit('conversation.item.truncated', {
        item_id: 'message-reply-1',
        content_index: 0,
        audio_end_ms: 120,
        prism_kept_text: 'Known retained text before playback stops',
      });
      await vi.waitFor(() => expect(truncated).toHaveBeenCalledOnce());
      if (mode === 'session') session.interrupt();
      else handle.interrupt();
      await handle.waitForPlayout();
      await vi.waitFor(() =>
        expect(peer.requests.some((q) => q.type === 'conversation.item.truncate')).toBe(true),
      );
      expect(peer.requests.some((q) => q.type === 'response.cancel')).toBe(false);
      expect((realtime.chatCtx.getById('message-reply-1') as llm.ChatMessage).content).toEqual([
        'Known retained text before playback stops',
      ]);
      const before = session.history.toJSON();
      peer.emit('conversation.item.truncated', {
        item_id: 'message-reply-1',
        content_index: 0,
        audio_end_ms: 120,
        prism_kept_text: 'All words retained by the server',
      });
      await vi.waitFor(() =>
        expect(truncated.mock.lastCall?.[0].keptText).toBe('All words retained by the server'),
      );
      expect((realtime.chatCtx.getById('message-reply-1') as llm.ChatMessage).content).toEqual([
        'All words retained by the server',
      ]);
      expect(session.history.toJSON()).toEqual(before);
    },
  );
});
