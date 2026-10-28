// SPDX-FileCopyrightText: 2026 LiveKit, Inc.
//
// SPDX-License-Identifier: Apache-2.0
import { initializeLogger, llm, voice } from '@livekit/agents';
import { AudioFrame } from '@livekit/rtc-node';
import type * as r from '@rimelabs/sdk';
import { execFile } from 'node:child_process';
import { ReadableStream } from 'node:stream/web';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  PrismIdleTimeoutError,
  type PrismItemTruncatedEvent,
  type PrismResponseEndedEvent,
  RealtimeModel,
} from './realtime_model.js';
import { PrismPeer, type Request, TestAudioOutput } from './test_helpers.js';

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
  it('labels one reply and deletes only its saved instruction', async () => {
    const { peer, model, session } = await setup();
    const labels = { call: 'this-reply', step: '2' };
    const pending = session.generateReply('Check in', { metadata: labels });
    labels.step = 'changed';
    const createdRequest = await request(peer);
    expect(createdRequest.response?.metadata).toMatchObject({
      prism_cause: 'proactive',
      call: 'this-reply',
      step: '2',
    });
    createdRequest.response!.metadata!.prism_instruction_item_id = 'saved-instruction';
    peer.history.push({
      id: 'saved-instruction',
      type: 'message',
      role: 'user',
      text: 'Check in',
    });
    peer.accepted(createdRequest);
    const generation = await pending;
    expect(generation.instructionItemId).toBe('saved-instruction');
    await expect(model.deleteInstructionItem(generation.instructionItemId!)).rejects.toThrow(
      'before its reply ends',
    );
    peer.message();
    peer.text();
    peer.audio();
    const ended = vi.fn();
    session.on('response_ended', ended);
    peer.ended();
    await vi.waitFor(() => expect(ended).toHaveBeenCalledOnce());
    await model.deleteInstructionItem(generation.instructionItemId!);
    expect(peer.requests.at(-1)).toMatchObject({
      type: 'conversation.item.delete',
      item_id: 'saved-instruction',
    });
    expect(peer.history.some((item) => item.id === 'saved-instruction')).toBe(false);
    await expect(model.deleteInstructionItem('saved-instruction')).rejects.toThrow(
      'Unknown saved Prism instruction item',
    );
  });

  it('reports the Prism idle timeout and its duration', async () => {
    const { peer, errors } = await setup();
    peer.emit('session.idle_timeout', { reason: 'idle_timeout', idle_timeout_s: 300 });
    await vi.waitFor(() => expect(errors).toHaveLength(1));
    expect(errors[0]?.error).toBeInstanceOf(PrismIdleTimeoutError);
    expect((errors[0]?.error as PrismIdleTimeoutError).idleTimeoutS).toBe(300);
  });

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

describe('Prism history', () => {
  async function setupHistory() {
    const state = await setup();
    const { session } = state;
    const ctx = llm.ChatContext.empty();
    ctx.addMessage({ role: 'system', content: 'Context', id: 'system' });
    ctx.addMessage({ role: 'user', content: 'Hello', id: 'user' });
    ctx.addMessage({ role: 'assistant', content: 'Welcome', id: 'assistant' });
    await session.updateChatCtx(ctx);
    return { ...state, ctx };
  }

  it('keeps independent acknowledged snapshots', async () => {
    const { session, ctx } = await setupHistory();
    (ctx.items[0] as llm.ChatMessage).content[0] = 'Changed externally';
    const copy = session.chatCtx;
    (copy.items[1] as llm.ChatMessage).content[0] = 'Changed snapshot';
    expect((session.chatCtx.items[0] as llm.ChatMessage).textContent).toBe('Context');
    expect((session.chatCtx.items[1] as llm.ChatMessage).textContent).toBe('Hello');
    const history = await session.getHistory();
    expect(history).toHaveLength(3);
  });

  it('preserves deletion-only edits without recreating surviving turns', async () => {
    const { peer, session } = await setupHistory();
    const ctx = session.chatCtx;
    ctx.remove('user');
    await session.updateChatCtx(ctx);
    expect(peer.requests.filter((q) => q.type === 'conversation.item.create')).toHaveLength(3);
    expect(peer.requests.filter((q) => q.type === 'conversation.item.delete')).toHaveLength(1);
    expect(
      (await session.getHistory()).map((item) => item.type === 'message' && item.text),
    ).toEqual(['Context', 'Welcome']);
  });

  it('rebuilds completed history when its order or content changes', async () => {
    const { peer, session } = await setupHistory();
    const ctx = session.chatCtx;
    ctx.items.reverse();
    (ctx.items[0] as llm.ChatMessage).content = ['Revised'];
    await session.updateChatCtx(ctx);
    expect(peer.requests.filter((q) => q.type === 'conversation.item.delete')).toHaveLength(3);
    expect(
      (await session.getHistory()).map((item) => item.type === 'message' && item.text),
    ).toEqual(['Revised', 'Hello', 'Context']);
  });

  it.each(['media', 'long', 'unicode', 'pending', 'orphan', 'duplicate', 'split-tool'])(
    'validates the whole %s edit before mutation',
    async (kind) => {
      const { peer, session } = await setupHistory();
      const ctx = session.chatCtx;
      ctx.addMessage({ role: 'user', content: 'This valid message must not be sent' });
      if (kind === 'media')
        ctx.addMessage({
          role: 'user',
          content: [
            { type: 'image_content', image: 'https://example.com/image.png' } as llm.ImageContent,
          ],
        });
      if (kind === 'long') ctx.addMessage({ role: 'user', content: 'x'.repeat(4001) });
      if (kind === 'unicode') ctx.addMessage({ role: 'user', content: '\ud800' });
      if (kind === 'duplicate') ctx.items.push(ctx.items[0]!);
      if (kind === 'pending' || kind === 'split-tool')
        ctx.items.push(new llm.FunctionCall({ callId: 'call', name: 'lookup', args: '{}' }));
      if (kind === 'split-tool')
        ctx.addMessage({ role: 'assistant', content: 'Between call and result' });
      if (kind === 'orphan' || kind === 'split-tool')
        ctx.items.push(
          new llm.FunctionCallOutput({ callId: 'call', output: '42', isError: false }),
        );
      const before = peer.requests.length;
      await expect(session.updateChatCtx(ctx)).rejects.toThrow();
      expect(peer.requests).toHaveLength(before);
      expect(session.chatCtx.items).toHaveLength(3);
    },
  );

  it('imports completed tools and deletes each pair once', async () => {
    const { peer, session } = await setupHistory();
    const ctx = session.chatCtx;
    ctx.items.push(new llm.FunctionCall({ callId: 'old', name: 'lookup', args: '{}' }));
    ctx.items.push(new llm.FunctionCallOutput({ callId: 'old', output: 'Oops', isError: true }));
    await session.updateChatCtx(ctx);
    expect(peer.history.at(-1)?.output).toContain('tool_error');
    await session.updateChatCtx(llm.ChatContext.empty());
    expect(peer.requests.filter((q) => q.type === 'conversation.item.delete')).toHaveLength(4);
    expect(peer.history).toEqual([]);
  });

  it('fails the session when a batch partially applies', async () => {
    const { peer, session, errors } = await setupHistory();
    let mutations = 0;
    peer.onRequest = (q) => {
      if (q.type === 'conversation.item.create' && ++mutations === 2) {
        peer.fault(q, 'invalid_item');
        return true;
      }
    };
    const ctx = session.chatCtx;
    ctx.addMessage({ role: 'user', content: 'First' });
    ctx.addMessage({ role: 'user', content: 'Second' });
    await expect(session.updateChatCtx(ctx)).rejects.toThrow('partially applied');
    await session.close();
    expect(errors.filter((error) => !error.recoverable)).toHaveLength(1);
    await expect(session.updateInstructions('Do not continue')).rejects.toThrow();
  });

  it('preserves events received while an edit waits for acknowledgment', async () => {
    const { peer, session } = await setupHistory();
    peer.onRequest = (q) => {
      if (q.type !== 'conversation.item.create') return;
      peer.emit('input_audio_buffer.committed', { item_id: 'spoken' });
      peer.emit('conversation.item.input_audio_transcription.completed', {
        item_id: 'spoken',
        transcript: 'Spoken during update',
      });
    };
    const ctx = session.chatCtx;
    ctx.addMessage({ role: 'user', content: 'Typed' });
    await session.updateChatCtx(ctx);
    await vi.waitFor(() => expect(session.chatCtx.getById('spoken')).toBeDefined());
    expect(session.chatCtx.items).toHaveLength(5);
  });

  it('does not replace live records with an incomplete server snapshot', async () => {
    const { peer, session } = await setupHistory();
    peer.accepted(undefined, 'live');
    peer.tool('live');
    await vi.waitFor(() => expect(session.chatCtx.getById('item-call-1')).toBeDefined());
    peer.history = [];
    expect(await session.getHistory()).toEqual([]);
    expect(session.chatCtx.getById('item-call-1')).toBeDefined();
    const ctx = session.chatCtx;
    ctx.items.reverse();
    await expect(session.updateChatCtx(ctx)).rejects.toThrow();
    peer.ended('live');
  });
});

describe('Prism truncation', () => {
  async function setupTruncation() {
    const { peer, session } = await setup({ requestTimeout: 1000 });
    const cuts: PrismItemTruncatedEvent[] = [];
    const ends: PrismResponseEndedEvent[] = [];
    session.on('item_truncated', (event) => cuts.push(event));
    session.on('response_ended', (event) => ends.push(event));
    return { peer, session, cuts, ends };
  }
  function acknowledge(
    peer: PrismPeer,
    keptText: string | null,
    itemId = 'message-reply-1',
    contentIndex = 0,
  ) {
    peer.emit('conversation.item.truncated', {
      item_id: itemId,
      content_index: contentIndex,
      audio_end_ms: 120,
      ...(keptText === null ? {} : { prism_kept_text: keptText }),
    });
  }
  async function completed({ peer, session }: Awaited<ReturnType<typeof setupTruncation>>) {
    peer.accepted();
    peer.message();
    peer.text('The full generated answer');
    peer.ended();
    await vi.waitFor(() => expect(session.chatCtx.getById('message-reply-1')).toBeDefined());
  }

  it.each([null, '', 'The full', 'The full generated answer'])(
    'applies retained text %j without changing snapshots or metadata',
    async (keptText) => {
      const state = await setupTruncation();
      const { peer, session, cuts } = state;
      await completed(state);
      const before = session.chatCtx.getById('message-reply-1') as llm.ChatMessage;
      acknowledge(peer, keptText);
      await vi.waitFor(() => expect(cuts).toHaveLength(1));
      const after = session.chatCtx.getById(before.id) as llm.ChatMessage;
      expect(after.content).toEqual([keptText ?? before.textContent]);
      expect(after.createdAt).toBe(before.createdAt);
      expect(before.textContent).toBe('The full generated answer');
      expect(cuts[0]).toMatchObject({
        itemId: before.id,
        contentIndex: 0,
        audioEndMs: 120,
        keptText,
      });
      acknowledge(peer, null);
      await vi.waitFor(() => expect(cuts).toHaveLength(2));
      expect(session.chatCtx.getById(before.id)).toEqual(after);
    },
  );

  it.each([null, '', 'Retained words'])(
    'preserves early retained text %j through completion and cleanup',
    async (keptText) => {
      const { peer, session, cuts, ends } = await setupTruncation();
      peer.accepted();
      peer.message();
      peer.text('Generated words');
      acknowledge(peer, keptText);
      acknowledge(peer, null);
      await vi.waitFor(() => expect(cuts).toHaveLength(2));
      peer.ended();
      await vi.waitFor(() => expect(ends).toHaveLength(1));
      expect((session.chatCtx.getById('message-reply-1') as llm.ChatMessage).content).toEqual([
        keptText ?? 'Generated words',
      ]);
      await session.updateChatCtx(llm.ChatContext.empty());
      await session.close();
      expect(session.chatCtx.items).toEqual([]);
    },
  );

  it.each(['', 'Server retained all words'])(
    'keeps early retained text %j when cancellation records a playback transcript',
    async (keptText) => {
      const { peer, session, cuts } = await setupTruncation();
      peer.accepted();
      peer.message();
      peer.text('Generated words');
      acknowledge(peer, keptText);
      await vi.waitFor(() => expect(cuts).toHaveLength(1));
      await session.truncate({
        messageId: 'message-reply-1',
        audioEndMs: 120,
        audioTranscript: 'Played',
      });
      expect((session.chatCtx.getById('message-reply-1') as llm.ChatMessage).content).toEqual([
        keptText,
      ]);
    },
  );

  it.each(['delete', 'replace'])('ignores stale acknowledgments after history %s', async (edit) => {
    const state = await setupTruncation();
    const { peer, session, cuts } = state;
    await completed(state);
    const target = session.chatCtx;
    if (edit === 'delete') target.items = [];
    else (target.getById('message-reply-1') as llm.ChatMessage).content = ['Replacement'];
    await session.updateChatCtx(target);
    acknowledge(peer, 'Stale text');
    await vi.waitFor(() => expect(cuts).toHaveLength(1));
    expect(session.chatCtx.items).toEqual(target.items);
    if (edit === 'replace') {
      const serverId = peer.history.find((item) => item.role === 'assistant')!.id!;
      acknowledge(peer, 'New retained text', serverId);
      await vi.waitFor(() => expect(cuts).toHaveLength(2));
      expect((session.chatCtx.getById('message-reply-1') as llm.ChatMessage).content).toEqual([
        'New retained text',
      ]);
    }
  });

  it.each(
    [false, true].flatMap((beforeEnd) =>
      ['', 'Server retained all words'].flatMap((keptText) =>
        ['unavailable', 'stale'].map((reply) => ({ beforeEnd, keptText, reply })),
      ),
    ),
  )(
    'keeps retained text through late playback cuts beforeEnd=$beforeEnd keptText=$keptText reply=$reply',
    async ({ beforeEnd, keptText, reply }) => {
      const { peer, session, cuts, ends } = await setupTruncation();
      peer.accepted();
      peer.message();
      peer.text('Generated words');
      if (beforeEnd) acknowledge(peer, keptText);
      peer.ended();
      if (!beforeEnd) acknowledge(peer, keptText);
      await vi.waitFor(() => {
        expect(cuts).toHaveLength(1);
        expect(ends).toHaveLength(1);
      });
      const before = session.chatCtx;
      if (reply === 'stale') {
        peer.onRequest = (request) => {
          if (request.type === 'conversation.item.truncate') {
            peer.fault(request, 'truncate_not_current');
            return true;
          }
        };
      }
      await session.truncate({
        messageId: 'message-reply-1',
        audioEndMs: 120,
        audioTranscript: 'Played',
      });
      // Repeated playback reports, including an empty transcript, cannot erase server text.
      await session.truncate({ messageId: 'message-reply-1', audioEndMs: 0 });
      expect(session.chatCtx.items).toEqual(before.items);
      expect(session.isClosed).toBe(false);

      acknowledge(peer, 'Updated retained text');
      await vi.waitFor(() => expect(cuts.at(-1)?.keptText).toBe('Updated retained text'));
      await session.truncate({ messageId: 'message-reply-1', audioEndMs: 0 });
      expect((session.chatCtx.getById('message-reply-1') as llm.ChatMessage).content).toEqual([
        'Updated retained text',
      ]);
    },
  );

  it.each(['delete', 'replace'])(
    'does not restore cached retained text after a history %s',
    async (edit) => {
      const state = await setupTruncation();
      const { peer, session, cuts } = state;
      await completed(state);
      acknowledge(peer, 'Retained words');
      await vi.waitFor(() => expect(cuts).toHaveLength(1));
      const target = session.chatCtx;
      if (edit === 'delete') target.items = [];
      else (target.getById('message-reply-1') as llm.ChatMessage).content = ['Replacement'];
      await session.updateChatCtx(target);
      await session.truncate({
        messageId: 'message-reply-1',
        audioEndMs: 120,
        audioTranscript: 'Played',
      });
      expect(session.chatCtx.items).toEqual(target.items);
      await session.close();
      expect(session.chatCtx.items).toEqual(target.items);
    },
  );

  it.each(['append', 'delete', 'replace'])(
    'preserves acknowledged history during a pending %s edit',
    async (edit) => {
      const state = await setupTruncation();
      const { peer, session, cuts } = state;
      await completed(state);
      const target = session.chatCtx;
      if (edit === 'append') target.addMessage({ role: 'user', content: 'Next' });
      else if (edit === 'delete') target.items = [];
      else (target.getById('message-reply-1') as llm.ChatMessage).content = ['Replacement'];
      let held: Request | undefined;
      peer.onRequest = (request) => {
        if (
          request.type === 'conversation.item.create' ||
          request.type === 'conversation.item.delete'
        ) {
          held = request;
          return true;
        }
      };
      const update = session.updateChatCtx(target);
      try {
        await vi.waitFor(() => expect(held).toBeDefined());
        acknowledge(peer, 'Retained words');
        await vi.waitFor(() => expect(cuts).toHaveLength(1));
      } finally {
        peer.onRequest = undefined;
        if (held?.type === 'conversation.item.create') {
          const item = { ...held.item!, id: 'held-item' };
          peer.history.push(item);
          peer.emit('conversation.item.created', { prism_request_event_id: held.event_id, item });
        } else if (held)
          peer.emit('conversation.item.deleted', {
            prism_request_event_id: held.event_id,
            item_id: held.item_id,
          });
        await update;
      }
      if (edit === 'append') {
        expect((session.chatCtx.getById('message-reply-1') as llm.ChatMessage).content).toEqual([
          'Retained words',
        ]);
        expect(session.chatCtx.items.at(-1)).toEqual(target.items.at(-1));
      } else expect(session.chatCtx.items).toEqual(target.items);
    },
  );

  it('treats unknown items and other content parts as diagnostics only', async () => {
    const state = await setupTruncation();
    const { peer, session, cuts } = state;
    await completed(state);
    const before = session.chatCtx;
    acknowledge(peer, 'Unknown', 'unknown');
    acknowledge(peer, 'Other part', 'message-reply-1', 1);
    await vi.waitFor(() => expect(cuts).toHaveLength(2));
    expect(session.chatCtx.items).toEqual(before.items);
  });

  it.each(['completed', 'cancelled', 'failed'])(
    'exposes %s response summaries without deleting history',
    async (status) => {
      const state = await setupTruncation();
      const { peer, session, cuts, ends } = state;
      await completed(state);
      const before = session.chatCtx;
      for (const [index, summary] of [
        undefined,
        { items_left_out: 3 },
        { items_left_out: 3, first_kept_item_id: 'kept' },
      ].entries()) {
        const id = `summary-${index}`;
        peer.accepted(undefined, id);
        peer.emit('response.done', {
          response: { id, status, ...(summary === undefined ? {} : { prism_truncation: summary }) },
        });
        await vi.waitFor(() => expect(ends).toHaveLength(index + 2));
        expect(ends.at(-1)).toMatchObject({
          status,
          truncation: summary
            ? { itemsLeftOut: 3, firstKeptItemId: summary.first_kept_item_id ?? null }
            : null,
        });
        expect(session.chatCtx.items).toEqual(before.items);
      }
      // History acknowledgments do not depend on completed response records.
      (session as unknown as { generations: Map<string, unknown> }).generations.clear();
      acknowledge(peer, 'Retained');
      await vi.waitFor(() => expect(cuts).toHaveLength(1));
      expect((session.chatCtx.getById('message-reply-1') as llm.ChatMessage).content).toEqual([
        'Retained',
      ]);
    },
  );

  it.each(
    [false, true].flatMap((abandoned) =>
      [false, true].flatMap((afterEnd) =>
        ['', 'Retained'].map((keptText) => ({ abandoned, afterEnd, keptText })),
      ),
    ),
  )(
    'preserves buffered truncation with abandoned=$abandoned afterEnd=$afterEnd keptText=$keptText',
    async ({ abandoned, afterEnd, keptText }) => {
      const { peer, session, cuts, ends } = await setupTruncation();
      const sdk = (session as unknown as { sdk: r.RealtimeSession }).sdk;
      const original = sdk.requestReply.bind(sdk);
      let release!: () => void;
      const gate = new Promise<void>((resolve) => {
        release = resolve;
      });
      vi.spyOn(sdk, 'requestReply').mockImplementation(async (...args) => {
        const ref = await original(...args);
        await gate;
        return ref;
      });
      const controller = new AbortController();
      const reply = session.generateReply(undefined, { signal: controller.signal });
      const result = reply.then(
        (value) => ({ value }),
        (error: unknown) => ({ error }),
      );
      try {
        await vi.waitFor(() =>
          expect(peer.requests.some((q) => q.type === 'response.create')).toBe(true),
        );
        peer.accepted(peer.requests.find((q) => q.type === 'response.create'));
        peer.message();
        peer.text('Generated');
        if (afterEnd) peer.ended();
        acknowledge(peer, keptText);
        acknowledge(peer, null);
        if (!afterEnd) peer.ended();
        await vi.waitFor(() => {
          expect(cuts).toHaveLength(2);
          expect(ends).toHaveLength(1);
        });
        expect(session.chatCtx.items).toEqual([]);
        if (abandoned) controller.abort();
      } finally {
        release();
      }
      const outcome = await result;
      if (abandoned) {
        expect(outcome).toHaveProperty('error');
        expect(session.chatCtx.items).toEqual([]);
      } else {
        expect(outcome).toHaveProperty('value');
        expect((session.chatCtx.getById('message-reply-1') as llm.ChatMessage).content).toEqual([
          keptText,
        ]);
      }
      expect(cuts).toHaveLength(2);
    },
  );
});

describe('Prism packaging', () => {
  it.each(['esm', 'cjs'])(
    'connects from the built %s package and retains TTS exports',
    async (format) => {
      const peer = await new PrismPeer().start();
      try {
        const load =
          format === 'esm'
            ? "const { realtime, TTS } = await import('./dist/index.js'); const core = await import('@livekit/agents');"
            : "const { realtime, TTS } = require('./dist/index.cjs'); const core = require('@livekit/agents');";
        const script = `${load}
      core.initializeLogger({ pretty: false, level: 'silent' });
      if (typeof TTS !== 'function') throw new Error('Missing TTS');
      const model = new realtime.RealtimeModel({ apiKey: 'test', endpoint: process.argv[1] });
      const session = model.session();
      await session.updateInstructions('Packaging check');
      if (model.sessionInfo.voice !== 'test') throw new Error('Connection failed');
      await model.close();
      console.log('connected');`;
        const wrapped =
          format === 'cjs'
            ? `(async () => { ${script} })().catch(error => { console.error(error); process.exitCode = 1; });`
            : script;
        const { stdout } = await promisify(execFile)(
          process.execPath,
          [...(format === 'esm' ? ['--input-type=module'] : []), '-e', wrapped, peer.endpoint],
          { cwd: fileURLToPath(new URL('../..', import.meta.url)), timeout: 5000 },
        );
        expect(stdout).toContain('connected');
      } finally {
        await peer.close();
      }
    },
  );
});
