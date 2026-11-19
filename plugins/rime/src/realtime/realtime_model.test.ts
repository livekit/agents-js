// SPDX-FileCopyrightText: 2026 LiveKit, Inc.
//
// SPDX-License-Identifier: Apache-2.0
import { initializeLogger, llm, voice } from '@livekit/agents';
import { AudioFrame, AudioResampler } from '@livekit/rtc-node';
import type * as r from '@rimelabs/sdk';
import { execFile } from 'node:child_process';
import { ReadableStream } from 'node:stream/web';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  PrismIdleTimeoutError,
  RealtimeModel,
  type RealtimeModelOptions,
} from './realtime_model.js';
import { OutputQueue } from './streams.js';
import { PrismPeer, type Request, TestAudioOutput } from './test_helpers.js';

initializeLogger({ pretty: false, level: 'silent' });
async function collect<T>(source: AsyncIterable<T>): Promise<T[]> {
  const result: T[] = [];
  for await (const item of source) result.push(item);
  return result;
}
const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => {
  const failures: unknown[] = [];
  try {
    for (const close of cleanup.splice(0).reverse()) {
      try {
        await close();
      } catch (error) {
        failures.push(error);
      }
    }
  } finally {
    vi.restoreAllMocks();
  }
  if (failures.length === 1) throw failures[0];
  if (failures.length > 1) throw new AggregateError(failures, 'Test cleanup failed');
});
async function setup(timeouts: { requestTimeout?: number; readyTimeout?: number } = {}) {
  const peer = await new PrismPeer().start();
  cleanup.push(() => peer.close());
  const model = new RealtimeModel({
    apiKey: 'test',
    contextMode: 'strict',
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
// Model defaults (shared context unless contextMode is passed) with a 500 ms request timeout.
async function setupDefaults(options: RealtimeModelOptions = {}) {
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
  const errors: llm.RealtimeModelError[] = [];
  session.on('error', (error) => errors.push(error));
  await session.updateInstructions('Test');
  return { peer, model, session, errors };
}
// Truncation and response completion are available only as raw SDK events.
function onRawPayload<K extends 'item.truncated' | 'response.ended'>(
  session: llm.RealtimeSession,
  kind: K,
  listener: (payload: Extract<r.SessionEvent['payload'], { kind: K }>) => void,
): void {
  session.on('rime_server_event_received', (event: r.SessionEvent) => {
    if (event.payload.kind === kind)
      listener(event.payload as Extract<r.SessionEvent['payload'], { kind: K }>);
  });
}
async function request(peer: PrismPeer, count = 1) {
  await vi.waitFor(() =>
    expect(peer.requests.filter((value) => value.type === 'response.create')).toHaveLength(count),
  );
  return peer.requests.filter((value) => value.type === 'response.create')[count - 1]!;
}

describe('Prism SDK adapter', () => {
  it('labels one requested reply and returns the standard generation event', async () => {
    const { peer, session } = await setup();
    const labels = { call: 'this-reply', step: '2' };
    const pending = session.generateReply('Check in', { metadata: labels });
    labels.step = 'changed';
    const createdRequest = await request(peer);
    expect(createdRequest.response?.metadata).toMatchObject({
      prism_cause: 'proactive',
      call: 'this-reply',
      step: '2',
    });
    peer.accepted(createdRequest);
    const generation = await pending;
    expect(Object.keys(generation).sort()).toEqual([
      'functionStream',
      'messageStream',
      'responseId',
      'userInitiated',
    ]);
    expect(generation.userInitiated).toBe(true);
    peer.message();
    peer.text();
    peer.audio();
    const ended = vi.fn();
    onRawPayload(session, 'response.ended', ended);
    peer.ended();
    await vi.waitFor(() => expect(ended).toHaveBeenCalledOnce());
    expect(peer.requests.some((q) => q.type === 'conversation.item.delete')).toBe(false);
  });

  it('reports the Prism idle timeout and its duration', async () => {
    const { peer, errors } = await setup();
    peer.emit('session.idle_timeout', { reason: 'idle_timeout', idle_timeout_s: 300 });
    await vi.waitFor(() => expect(errors).toHaveLength(1));
    expect(errors[0]?.error).toBeInstanceOf(PrismIdleTimeoutError);
    expect((errors[0]?.error as PrismIdleTimeoutError).idleTimeoutInS).toBe(300);
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
    const { peer, model, session, errors } = await setup();
    peer.onRequest = (request) => {
      if (request.type === 'session.update' && request.session?.prism_response_metadata) {
        peer.fault(request, 'invalid_metadata');
        return true;
      }
    };
    expect(
      model.updateOptions({ voice: 'accepted-voice', responseMetadata: { step: '2' } }),
    ).toBeUndefined();
    await session.updateInstructions('After options');
    expect(errors.some((error) => error.recoverable)).toBe(true);
    expect(peer.settings.voice).toBe('accepted-voice');
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
    model.updateOptions(options);
    options.voice = 'mutated-after-call';
    await session.updateInstructions('After options');
    expect(peer.settings.voice).toBe('requested-voice');
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
    // Abort once Prism receives the temporary tool removal, before the reply request.
    peer.onRequest = (q) => {
      if (q.type === 'session.update' && Array.isArray(q.session?.tools) && !q.session.tools.length)
        abort.abort();
    };
    await expect(session.generateReply(undefined, { signal: abort.signal })).rejects.toThrow();
    expect(peer.requests.filter((q) => q.type === 'response.create')).toEqual([]);
    expect(errors).toEqual([]);
    session.updateOptions({ toolChoice: 'auto' });
    const next = session.generateReply();
    peer.reply(await request(peer));
    await next;
  });
  it.each([false, true])(
    'continues the owning response after tool submission, refusal=%s',
    async (refuse) => {
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
      for (const [index, call] of calls.entries())
        ctx.items.push(
          new llm.FunctionCallOutput({
            callId: call.callId,
            output: '42',
            isError: false,
            replyRequired: index === 0,
          }),
        );
      if (refuse) {
        let results = 0;
        peer.onRequest = (q) => {
          if (q.item?.type === 'function_call_output' && ++results === 2) {
            peer.fault(q, 'invalid_item');
            return true;
          }
        };
        await expect(session.updateChatCtx(ctx)).rejects.toMatchObject({ recoverable: true });
      }
      await session.updateChatCtx(ctx);
      const next = session.generateReply();
      const q = await request(peer, 2);
      expect(q.response).toMatchObject(
        refuse ? { prism_call_id: 'one' } : { metadata: { prism_parent_response_id: 'reply-1' } },
      );
      peer.reply(q, 'next');
      await next;
      expect(peer.requests.filter((q) => q.item?.type === 'function_call_output')).toHaveLength(
        refuse ? 3 : 2,
      );
    },
  );
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
    const { peer, model, session } = await setup();
    // setup() resolves only after Prism acknowledges these settings.
    expect(peer.requests[0]).toMatchObject({ type: 'session.update' });
    expect(peer.settings).toMatchObject({ instructions: 'Test' });
    expect(peer.revision).toBeGreaterThan(0);
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
    await expect(session.commitAudio()).resolves.toBeUndefined();
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
  it('keeps a long reply that arrives faster than playback reads it', async () => {
    const { peer, session, errors } = await setup();
    const pending = session.generateReply();
    peer.accepted(await request(peer));
    peer.message();
    const generation = await pending;
    // 600 deltas of 100 ms: one minute of audio, unread until the reply ends.
    for (let i = 0; i < 600; i++) {
      peer.text(`${i} `);
      peer.audio();
    }
    peer.ended();
    const [message] = await collect(generation.messageStream);
    const [text, audio] = await Promise.all([
      collect(message!.textStream),
      collect(message!.audioStream),
    ]);
    expect(text).toHaveLength(600);
    expect(audio).toHaveLength(600);
    expect(errors).toEqual([]);
    expect(session.isClosed).toBe(false);
  });
  it('drops unread output of a long reply when it is truncated', async () => {
    const { peer, session, errors } = await setup();
    const pending = session.generateReply();
    peer.accepted(await request(peer));
    peer.message();
    const generation = await pending;
    for (let i = 0; i < 300; i++) peer.audio();
    peer.text('done');
    const { value: message } = await generation.messageStream.getReader().read();
    // The text delta follows every audio delta, so all 300 frames are queued unread.
    await message!.textStream.getReader().read();
    await session.truncate({ messageId: message!.messageId, audioEndMs: 500 });
    await expect(collect(message!.audioStream)).rejects.toThrow('Prism output was interrupted');
    expect(errors.filter((value) => !value.recoverable)).toEqual([]);
    expect(session.isClosed).toBe(false);
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
  it('closes each replaced input resampler', async () => {
    const closed = vi.spyOn(AudioResampler.prototype, 'close');
    const { session } = await setup();
    const frame = (rate: number) => new AudioFrame(new Int16Array(rate / 100), rate, 1, rate / 100);
    session.pushAudio(frame(44100));
    await session.clearAudio();
    expect(closed).toHaveBeenCalledTimes(1);
    session.pushAudio(frame(44100));
    session.pushAudio(frame(32000));
    expect(closed).toHaveBeenCalledTimes(2);
    // Supported rates do not create a resampler, so switching to one only releases the old one.
    session.pushAudio(frame(16000));
    expect(closed).toHaveBeenCalledTimes(3);
    session.pushAudio(frame(44100));
    await session.close();
    expect(closed).toHaveBeenCalledTimes(4);
  });
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
  async function start(maxToolSteps = 3, contextMode: 'shared' | 'strict' = 'shared') {
    const peer = await new PrismPeer().start();
    cleanup.push(() => peer.close());
    const model = new RealtimeModel({
      apiKey: 'test',
      endpoint: peer.endpoint,
      requestTimeout: 500,
      contextMode,
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
    const execute = vi.fn(async (_: unknown, _options: { ctx: voice.RunContext }) => '42');
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
  it.each(['shared', 'strict'] as const)(
    'stops a rejected tool reply but permits independent replies and result recovery in %s mode',
    async (contextMode) => {
      const { peer, session, execute, realtime } = await start(3, contextMode);
      const errors: llm.RealtimeModelError[] = [];
      realtime.on('error', (error) => errors.push(error));
      peer.onRequest = (q) => {
        if (q.item?.type === 'function_call_output') {
          peer.fault(q, 'invalid_item');
          return true;
        }
        if (
          q.type === 'response.create' &&
          peer.requests.filter((request) => request.type === 'response.create').length > 1
        ) {
          peer.reply(q, 'unexpected-dependent-reply');
          return true;
        }
      };
      const failed = session.generateReply();
      peer.accepted(await request(peer));
      peer.tool('reply-1', 'one');
      peer.ended();
      await failed.waitForPlayout();
      expect(peer.requests.filter((q) => q.type === 'response.create')).toHaveLength(1);
      expect(realtime.chatCtx.items.filter((item) => item.type === 'function_call_output')).toEqual(
        [],
      );
      expect(execute).toHaveBeenCalledTimes(1);
      expect(errors).toHaveLength(1);
      expect(errors[0]?.recoverable).toBe(true);
      expect(realtime.isClosed).toBe(false);

      peer.onRequest = undefined;
      for (const userInput of [undefined, 'An independent question']) {
        const count = peer.requests.filter((q) => q.type === 'response.create').length;
        const independent = session.generateReply({ userInput });
        peer.reply(await request(peer, count + 1), `independent-${count}`);
        await independent.waitForPlayout();
      }
      const retry = realtime.chatCtx;
      retry.items.push(
        ...session.currentAgent.chatCtx.items.filter(
          (item) => item.type === 'function_call_output' && item.callId === 'one',
        ),
      );
      await realtime.updateChatCtx(retry);
      const recovered = session.generateReply();
      const reply = await request(peer, 4);
      expect(reply.response).toMatchObject({ prism_call_id: 'one' });
      peer.reply(reply, 'recovered');
      await recovered.waitForPlayout();
      expect(execute).toHaveBeenCalledTimes(1);
      expect(peer.history.filter((item) => item.type === 'function_call_output')).toHaveLength(1);
    },
  );
  it('does not cancel an independent reply queued while a tool result is rejected', async () => {
    const { peer, session, execute } = await start();
    let reject: (() => void) | undefined;
    peer.onRequest = (q) => {
      if (q.item?.type !== 'function_call_output') return;
      reject = () => peer.fault(q, 'invalid_item');
      return true;
    };
    const failed = session.generateReply();
    peer.accepted(await request(peer));
    peer.tool('reply-1', 'one');
    peer.ended();
    await vi.waitFor(() => expect(reject).toBeDefined());
    const independent = session.generateReply();
    reject!();
    await failed.waitForPlayout();
    peer.reply(await request(peer, 2), 'independent');
    await independent.waitForPlayout();
    expect(independent.interrupted).toBe(false);
    expect(execute).toHaveBeenCalledTimes(1);
    expect(peer.requests.filter((q) => q.type === 'response.create')).toHaveLength(2);
  });
  it('allows a background tool to finish after its first progress reply is rejected', async () => {
    const { peer, session, execute } = await start();
    let finish!: () => void;
    const released = new Promise<void>((resolve) => {
      finish = resolve;
    });
    execute.mockImplementationOnce(async (_, { ctx }) => {
      await ctx.update('Working');
      await released;
      return 'Final result';
    });
    let refused = false;
    peer.onRequest = (q) => {
      if (q.item?.type === 'function_call_output' && !refused) {
        refused = true;
        peer.fault(q, 'invalid_item');
        return true;
      }
    };
    const failed = session.generateReply();
    peer.accepted(await request(peer));
    peer.tool('reply-1', 'one');
    peer.ended();
    await failed.waitForPlayout();
    expect(refused).toBe(true);
    expect(peer.requests.filter((q) => q.type === 'response.create')).toHaveLength(1);
    finish();
    peer.reply(await request(peer, 2), 'final-result');
    await session.waitForIdle();
    expect(execute).toHaveBeenCalledTimes(1);
    expect(
      peer.history.some((item) => item.call_id === 'one_final' && item.output === 'Final result'),
    ).toBe(true);
  });
  it('keeps an automatic reply tied to accepted results after a partial tool update', async () => {
    const { peer, session, execute, realtime } = await start();
    const errors: llm.RealtimeModelError[] = [];
    realtime.on('error', (error) => errors.push(error));
    let results = 0;
    peer.onRequest = (q) => {
      if (q.item?.type === 'function_call_output' && ++results === 2) {
        peer.fault(q, 'invalid_item');
        return true;
      }
    };
    const handle = session.generateReply();
    peer.accepted(await request(peer));
    peer.tool('reply-1', 'one');
    peer.tool('reply-1', 'two');
    peer.ended();
    const acceptedResultReply = await request(peer, 2);
    expect(acceptedResultReply.response).toMatchObject({ prism_call_id: 'one' });
    peer.reply(acceptedResultReply, 'accepted-result');
    await handle.waitForPlayout();
    expect(execute).toHaveBeenCalledTimes(2);
    expect(results).toBe(2);
    expect(errors.filter((error) => !error.recoverable)).toEqual([]);
    expect(
      realtime.chatCtx.items.filter((item) => item.type === 'function_call_output'),
    ).toHaveLength(1);
    await realtime.updateChatCtx(realtime.chatCtx);
    expect(peer.requests.filter((q) => q.type === 'response.create')).toHaveLength(2);
    const retry = realtime.chatCtx;
    retry.items.push(
      ...session.currentAgent.chatCtx.items.filter(
        (i) => i.type === 'function_call_output' && i.callId === 'two',
      ),
    );
    await realtime.updateChatCtx(retry);
    const reply = session.generateReply();
    const continuation = await request(peer, 3);
    expect(continuation.response).toMatchObject({ prism_call_id: 'two' });
    peer.reply(continuation, 'recovered');
    await reply.waitForPlayout();
    expect(results).toBe(3);
    expect(execute).toHaveBeenCalledTimes(2);
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
    'cancels provider output using %s interruption before the first message',
    async (mode) => {
      const { peer, session } = await start();
      const handle = session.generateReply();
      peer.accepted(await request(peer));
      // Wait until generation creation has reached LiveKit, with no message/audio to truncate.
      await new Promise((resolve) => setTimeout(resolve, 30));
      if (mode === 'session') session.interrupt();
      else handle.interrupt();
      await vi.waitFor(() =>
        expect(peer.requests.some((q) => q.type === 'response.cancel')).toBe(true),
      );
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
      onRawPayload(realtime, 'item.truncated', truncated);
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
    const { peer, session, ctx } = await setupHistory();
    (ctx.items[0] as llm.ChatMessage).content[0] = 'Changed externally';
    const copy = session.chatCtx;
    (copy.items[1] as llm.ChatMessage).content[0] = 'Changed snapshot';
    expect((session.chatCtx.items[0] as llm.ChatMessage).textContent).toBe('Context');
    expect((session.chatCtx.items[1] as llm.ChatMessage).textContent).toBe('Hello');
    expect(peer.history).toHaveLength(3);
  });

  it('preserves deletion-only edits without recreating surviving turns', async () => {
    const { peer, session } = await setupHistory();
    const ctx = session.chatCtx;
    ctx.remove('user');
    await session.updateChatCtx(ctx);
    expect(peer.requests.filter((q) => q.type === 'conversation.item.create')).toHaveLength(3);
    expect(peer.requests.filter((q) => q.type === 'conversation.item.delete')).toHaveLength(1);
    expect(peer.history.map((item) => item.type === 'message' && item.text)).toEqual([
      'Context',
      'Welcome',
    ]);
  });

  it('rebuilds completed history when its order or content changes', async () => {
    const { peer, session } = await setupHistory();
    const ctx = session.chatCtx;
    ctx.items.reverse();
    (ctx.items[0] as llm.ChatMessage).content = ['Revised'];
    await session.updateChatCtx(ctx);
    expect(peer.requests.filter((q) => q.type === 'conversation.item.delete')).toHaveLength(3);
    expect(peer.history.map((item) => item.type === 'message' && item.text)).toEqual([
      'Revised',
      'Hello',
      'Context',
    ]);
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

  it('keeps accepted appends and retries only missing items after an explicit refusal', async () => {
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
    await expect(session.updateChatCtx(ctx)).rejects.toMatchObject({
      code: 'history_update_partial',
      recoverable: true,
    });
    expect(session.chatCtx.items.at(-1)).toMatchObject({ content: ['First'] });
    expect(errors.filter((error) => !error.recoverable)).toHaveLength(0);
    await session.updateChatCtx(ctx);
    expect(peer.history.filter((item) => item.text === 'First')).toHaveLength(1);
    expect(peer.history.at(-1)?.text).toBe('Second');
    expect(mutations).toBe(3);
  });
  it.each([1, 2])('recovers an imported tool pair refused at operation %s', async (refusedAt) => {
    const { peer, session } = await setup();
    const target = llm.ChatContext.empty();
    target.items.push(new llm.FunctionCall({ callId: 'imported', name: 'lookup', args: '{}' }));
    target.items.push(
      new llm.FunctionCallOutput({ callId: 'imported', output: '42', isError: false }),
    );
    let mutations = 0;
    peer.onRequest = (q) => {
      if (q.type === 'conversation.item.create' && ++mutations === refusedAt) {
        peer.fault(q, 'invalid_item');
        return true;
      }
    };
    await expect(session.updateChatCtx(target)).rejects.toMatchObject({ recoverable: true });
    expect(session.chatCtx.items).toHaveLength(refusedAt - 1);
    await session.updateChatCtx(session.chatCtx);
    {
      const reply = session.generateReply();
      peer.accepted(await request(peer));
      peer.ended();
      await reply;
    }
    await session.updateChatCtx(target);
    expect(peer.history).toHaveLength(2);
    expect(mutations).toBe(3);
    const next = session.generateReply();
    peer.reply(await request(peer, 2), 'recovered-import');
    await next;
  });
  it.each(['replacement', 'session', 'disconnect'])(
    'distinguishes known %s failures from uncertain outcomes',
    async (failure) => {
      const { peer, session, errors } = await setupHistory();
      let mutations = 0;
      peer.onRequest = (q) => {
        if (
          (q.type === 'conversation.item.create' || q.type === 'conversation.item.delete') &&
          ++mutations === 2
        ) {
          if (failure === 'disconnect') peer.socket.close();
          else peer.fault(q, 'invalid_item', failure === 'session' ? 'session' : 'event');
          return true;
        }
      };
      const target = failure === 'replacement' ? llm.ChatContext.empty() : session.chatCtx;
      target.addMessage({ role: 'user', content: 'First' });
      target.addMessage({ role: 'user', content: 'Second' });
      const failed = session.updateChatCtx(target);
      if (failure === 'replacement') {
        await expect(failed).rejects.toMatchObject({ status: 'partial', recoverable: true });
        await session.updateInstructions('can continue');
        expect(errors.filter((e) => !e.recoverable)).toEqual([]);
        return;
      } else await expect(failed).rejects.toMatchObject({ recoverable: false });
      await vi.waitFor(() => expect(errors.some((error) => !error.recoverable)).toBe(true));
      await expect(session.updateInstructions('must not continue')).rejects.toThrow();
    },
  );

  it('preserves events received while an edit waits for acknowledgment', async () => {
    const { peer, session } = await setupHistory();
    peer.onRequest = (q) => {
      if (q.type !== 'conversation.item.create') return;
      peer.history.push({
        id: 'spoken',
        type: 'message',
        role: 'user',
        text: 'Spoken during update',
      });
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
    expect(session.chatCtx.getById('item-call-1')).toBeDefined();
    const ctx = session.chatCtx;
    ctx.items.reverse();
    await expect(session.updateChatCtx(ctx)).rejects.toThrow();
    peer.ended('live');
  });
});

// Shared-history defaults, playback modes, connection retries, and tool references.
describe('Prism shared history and recovery', () => {
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
    const { session, peer } = await setupDefaults();
    session.on('error', (error) => notices.push(error));
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
  it('replaces and clears active agent context through standard strict updates', async () => {
    const peer = await new PrismPeer().start();
    cleanup.push(() => peer.close());
    const model = new RealtimeModel({
      apiKey: 'test',
      endpoint: peer.endpoint,
      contextMode: 'strict',
    });
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
    await agent.updateChatCtx(context('old'));
    await agent.updateChatCtx(context('replacement'));
    expect(peer.history.map((item) => item.text)).toEqual(['replacement']);
    await agent.updateChatCtx(llm.ChatContext.empty());
    expect(peer.history).toEqual([]);
  });
  it.each(['auto', 'estimated', 'discard'] as const)(
    'uses %s playback without false receipts',
    async (playback) => {
      const { peer, session } = await setupDefaults({ playback });
      const output = new TestAudioOutput();
      const generation = await reply(peer, session);
      const messages = await collect(generation.messageStream);
      const frames = await collect(messages[0]!.audioStream);
      expect((await collect(messages[0]!.textStream)).join('')).toBe('Hello');
      expect(frames.length > 0).toBe(playback !== 'discard');
      const receipts = () => peer.requests.filter((q) => q.type === 'prism.playback.drained');
      if (playback !== 'discard') expect(receipts()).toEqual([]);
      for (const frame of frames) await output.captureFrame(frame);
      output.flush();
      if (playback !== 'discard') {
        await new Promise((resolve) => setTimeout(resolve, 30));
        expect(receipts()).toEqual([]);
      } else {
        await vi.waitFor(() => expect(receipts()).toHaveLength(1));
        expect(receipts()[0]).toMatchObject({ played_ms: 0 });
      }
    },
  );
  it('emits raw events and one usage record when completion follows local interruption', async () => {
    const { peer, session } = await setupDefaults({ playback: 'discard' });
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

  it('restores tools at acceptance and permits newer automatic responses before completion', async () => {
    const { peer, session } = await setupDefaults();
    const errors: unknown[] = [];
    session.on('error', (e) => errors.push(e));
    await session.updateTools(
      new llm.ToolContext({
        lookup: llm.tool({ description: 'Lookup', execute: async () => '42' }),
      }),
    );
    session.updateOptions({ toolChoice: 'none' });
    const pending = session.generateReply();
    await vi.waitFor(() => expect(peer.requests.at(-1)?.type).toBe('response.create'));
    expect(peer.settings.tools).toEqual([]);
    const suppressed = peer.revision;
    peer.accepted(peer.requests.at(-1)!);
    await pending;
    expect(peer.settings.tools).toHaveLength(1);
    expect(peer.revision).toBeGreaterThan(suppressed);
    const automatic = new Promise<llm.GenerationCreatedEvent>((resolve) =>
      session.once('generation_created', resolve),
    );
    peer.accepted(undefined, 'automatic', peer.revision);
    peer.tool('automatic', 'new-policy-call');
    peer.ended('automatic');
    const event = await automatic;
    expect((await collect(event.functionStream)).map((call) => call.callId)).toEqual([
      'new-policy-call',
    ]);
    expect(errors).toEqual([]);
  });

  it('retains a slow tool reference across more than 128 later responses', async () => {
    const { peer, session } = await setupDefaults();
    peer.onRequest = (q) => {
      if (q.type !== 'response.create') return;
      const count = peer.requests.filter((r) => r.type === 'response.create').length;
      peer.accepted(q, `response-${count}`);
      if (count === 1) peer.tool('response-1', 'slow-call');
      peer.ended(`response-${count}`);
      return true;
    };
    const first = await session.generateReply();
    await collect(first.functionStream);
    for (let i = 0; i < 130; i++) {
      const generation = await session.generateReply();
      await collect(generation.messageStream);
    }
    const ctx = session.chatCtx;
    ctx.items.push(
      new llm.FunctionCallOutput({ callId: 'slow-call', output: 'done', isError: false }),
    );
    await session.updateChatCtx(ctx);
    await session.generateReply();
    expect(
      peer.requests.filter((q) => q.type === 'response.create').at(-1)?.response,
    ).toMatchObject({
      prism_call_id: 'slow-call',
    });
    expect(session.isClosed).toBe(false);
  }, 10000);
});

describe('Prism truncation', () => {
  async function setupTruncation() {
    const { peer, session } = await setup({ requestTimeout: 1000 });
    const cuts: r.ItemTruncated[] = [];
    const ends: r.ResponseEnded[] = [];
    onRawPayload(session, 'item.truncated', (payload) => cuts.push(payload));
    onRawPayload(session, 'response.ended', (payload) => ends.push(payload));
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
      // Resolves only after Prism acknowledges the connection's settings.
      await session.updateInstructions('Packaging check');
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
        expect(peer.settings.instructions).toBe('Packaging check');
      } finally {
        await peer.close();
      }
    },
  );
});

// Asynchronous tool progress, filler order, and option snapshots.
describe('Prism tool progress', () => {
  const setupProgress = (strict = false) =>
    setupDefaults({ contextMode: strict ? 'strict' : 'shared' });
  function pair(id: string, createdAt = Date.now()): [llm.FunctionCall, llm.FunctionCallOutput] {
    return [
      new llm.FunctionCall({
        id,
        callId: id,
        name: 'lookup',
        args: '{}',
        createdAt,
        extra: { __livekit_agents_tool_non_blocking: true },
      }),
      new llm.FunctionCallOutput({
        id: `result-${id}`,
        callId: id,
        name: 'lookup',
        output: id,
        isError: false,
        createdAt,
      }),
    ];
  }
  async function generated(
    peer: PrismPeer,
    session: ReturnType<RealtimeModel['session']>,
    id: string,
  ) {
    peer.accepted(undefined, id);
    peer.message(id);
    peer.text('Working', id, true);
    peer.ended(id);
    peer.history.push({ id: `message-${id}`, type: 'message', role: 'assistant', text: 'Working' });
    await vi.waitFor(() =>
      expect(session.chatCtx.items.some((i) => i.id === `message-${id}`)).toBe(true),
    );
  }
  async function liveCall(peer: PrismPeer, session: ReturnType<RealtimeModel['session']>) {
    peer.accepted(undefined, 'tool-reply');
    peer.tool('tool-reply', 'progress');
    peer.ended('tool-reply');
    await vi.waitFor(() =>
      expect(session.chatCtx.items.some((item) => item.type === 'function_call')).toBe(true),
    );
    const call = session.chatCtx.items.find(
      (item) => item.type === 'function_call',
    )! as llm.FunctionCall;
    call.extra.__livekit_agents_tool_non_blocking = true;
    return [call, pair('progress')[1]] as const;
  }
  // A filler ends while the first progress write awaits acknowledgment. The repair
  // read restores Prism's message-before-call order, unlike core's playout order.
  async function repairedFillerProgress(strict = false) {
    const context = await setupProgress(strict);
    const { peer, session } = context;
    peer.accepted(undefined, 'tool-reply');
    peer.message('tool-reply');
    peer.text('Working', 'tool-reply', true);
    peer.history.push({
      id: 'message-tool-reply',
      type: 'message',
      role: 'assistant',
      text: 'Working',
    });
    peer.tool('tool-reply', 'progress');
    await vi.waitFor(() => expect(session.chatCtx.items).toHaveLength(1));
    const call = session.chatCtx.items[0]! as llm.FunctionCall;
    call.extra.__livekit_agents_tool_non_blocking = true;
    const output = pair('progress')[1];
    let acknowledge: (() => void) | undefined;
    peer.onRequest = (request) => {
      if (request.type !== 'conversation.item.create') return;
      acknowledge = () => {
        const item = { ...request.item!, id: 'saved-progress' };
        peer.history.push(item);
        peer.emit('conversation.item.created', {
          prism_request_event_id: request.event_id,
          item,
        });
      };
      return true;
    };
    const pending = session.updateChatCtx(new llm.ChatContext([call, output]));
    await vi.waitFor(() => expect(acknowledge).toBeDefined());
    peer.ended('tool-reply');
    await vi.waitFor(() => expect(session.chatCtx.items).toHaveLength(2));
    acknowledge!();
    await pending;
    peer.onRequest = undefined;
    expect(session.chatCtx.items.map((item) => item.id)).toEqual([
      'message-tool-reply',
      call.id,
      output.id,
    ]);
    const message = session.chatCtx.items[0]! as llm.ChatMessage;
    return { ...context, call, output, message };
  }
  it('accepts a shared handoff with the same response filler after its tool call', async () => {
    const { peer, session, call, output, message, errors } = await repairedFillerProgress();
    const before = session.chatCtx.toJSON();
    const requests = peer.requests.length;
    await session.updateChatCtx(new llm.ChatContext([call, output, message]));
    await session.updateChatCtx(new llm.ChatContext([call, output, message]));
    expect(session.chatCtx.toJSON()).toEqual(before);
    expect(peer.requests).toHaveLength(requests);
    expect(errors).toEqual([]);
  });
  it.each(['message', 'call', 'output'])(
    'rejects changed %s in a reordered handoff',
    async (kind) => {
      const { peer, session, call, output, message } = await repairedFillerProgress();
      if (kind === 'message') message.content = ['Changed'];
      if (kind === 'call') call.args = '{"changed":true}';
      if (kind === 'output') output.output = 'Changed';
      const requests = peer.requests.length;
      await expect(
        session.updateChatCtx(new llm.ChatContext([call, output, message])),
      ).rejects.toThrow();
      expect(peer.requests).toHaveLength(requests);
    },
  );
  it('does not normalize a call across a message from another response', async () => {
    const { peer, session } = await setupProgress();
    const [call, output] = await liveCall(peer, session);
    await generated(peer, session, 'unrelated');
    const ctx = session.chatCtx;
    ctx.items.push(output);
    await session.updateChatCtx(ctx);
    const message = session.chatCtx.items.find((item) => item.type === 'message')!;
    const requests = peer.requests.length;
    await expect(
      session.updateChatCtx(new llm.ChatContext([message, call, output])),
    ).rejects.toThrow('append order');
    expect(peer.requests).toHaveLength(requests);
  });
  it('does not reorder tool calls within the same response', async () => {
    const { peer, session } = await setupProgress();
    peer.accepted(undefined, 'multiple');
    peer.tool('multiple', 'first');
    peer.tool('multiple', 'second');
    peer.ended('multiple');
    await vi.waitFor(() => expect(session.chatCtx.items).toHaveLength(2));
    const calls = session.chatCtx.items as llm.FunctionCall[];
    for (const call of calls) call.extra.__livekit_agents_tool_non_blocking = true;
    const requests = peer.requests.length;
    await expect(session.updateChatCtx(new llm.ChatContext(calls.reverse()))).rejects.toThrow(
      'append order',
    );
    expect(peer.requests).toHaveLength(requests);
  });
  it('does not reorder messages within the same response', async () => {
    const { peer, session } = await setupProgress();
    peer.accepted(undefined, 'multiple');
    for (const id of ['first', 'second']) {
      peer.message('multiple', id);
      peer.emit('response.text.done', {
        response_id: 'multiple',
        item_id: id,
        output_index: 0,
        content_index: 0,
        text: id,
      });
    }
    peer.ended('multiple');
    await vi.waitFor(() => expect(session.chatCtx.items).toHaveLength(2));
    const requests = peer.requests.length;
    await expect(
      session.updateChatCtx(new llm.ChatContext(session.chatCtx.items.reverse())),
    ).rejects.toThrow('append order');
    expect(peer.requests).toHaveLength(requests);
  });
  it('keeps strict edits of same-response filler order explicit', async () => {
    const { peer, session, call, output, message } = await repairedFillerProgress(true);
    await session.updateChatCtx(new llm.ChatContext([call, output, message]));
    expect(session.chatCtx.items.map((item) => item.id)).toEqual([call.id, output.id, message.id]);
    expect(peer.requests.some((request) => request.type === 'conversation.item.delete')).toBe(true);
  });
  it.each([false, true])(
    'normalizes unchanged interleaved progress in strict=%s',
    async (strict) => {
      const { peer, session } = await setupProgress(strict);
      const [call, output] = await liveCall(peer, session);
      await generated(peer, session, 'filler');
      const before = session.chatCtx;
      before.items.push(output);
      await session.updateChatCtx(before);
      const writes = peer.requests.filter((q) => q.type === 'conversation.item.create').length;
      const current = session.chatCtx;
      const message = current.items.find((i) => i.type === 'message')!;
      await session.updateChatCtx(new llm.ChatContext([call, output, message, ...pair('next')]));
      expect(session.chatCtx.items.map((i) => i.id)).toEqual([
        call.id,
        message.id,
        output.id,
        'next',
        'result-next',
      ]);
      expect(peer.requests.filter((q) => q.type === 'conversation.item.create')).toHaveLength(
        writes + 2,
      );
    },
  );
  it('preserves late generated messages omitted by a stale strict progress append', async () => {
    const { peer, session } = await setupProgress(true);
    const initial = pair('initial');
    await session.updateChatCtx(new llm.ChatContext(initial));
    const next = pair('next', Date.now() - 1000);
    await generated(peer, session, 'late');
    await session.updateChatCtx(new llm.ChatContext([...initial, ...next]));
    expect(session.chatCtx.items.map((i) => i.id)).toEqual([
      'initial',
      'result-initial',
      'message-late',
      'next',
      'result-next',
    ]);
    expect(peer.requests.some((q) => q.type === 'conversation.item.delete')).toBe(false);
  });
  it('does not move progress results across omitted user messages', async () => {
    const { peer, session } = await setupProgress();
    const [call, output] = await liveCall(peer, session);
    const user = llm.ChatMessage.create({ role: 'user', content: 'barrier' });
    await generated(peer, session, 'filler');
    const withUser = session.chatCtx;
    withUser.items.push(user);
    await session.updateChatCtx(withUser);
    const before = session.chatCtx;
    before.items.push(output);
    await session.updateChatCtx(before);
    const message = session.chatCtx.items.find((i) => i.id === 'message-filler')!;
    await expect(
      session.updateChatCtx(new llm.ChatContext([call, output, message])),
    ).rejects.toThrow('append order');
  });
  it('rejects changed progress content before writing', async () => {
    const { peer, session } = await setupProgress();
    const initial = pair('initial');
    await session.updateChatCtx(new llm.ChatContext(initial));
    const writes = peer.requests.length;
    initial[1].output = 'changed';
    await expect(session.updateChatCtx(new llm.ChatContext(initial))).rejects.toThrow('conflicts');
    expect(peer.requests).toHaveLength(writes);
  });
  it('preserves inactive filler configuration across tool removal and clears explicitly', async () => {
    const { peer, model, session } = await setupProgress();
    const fillers = {
      lookup: { type: 'text' as const, text: 'Checking' },
      future: { type: 'text' as const, text: 'Later' },
    };
    model.updateOptions({ toolFillers: fillers });
    fillers.lookup.text = 'mutated';
    const tools = new llm.ToolContext({
      lookup: llm.tool({ description: 'Lookup', execute: async () => 'done' }),
    });
    await session.updateTools(tools);
    expect(peer.settings.tools).toMatchObject([
      { function: { name: 'lookup' }, prism_filler: { text: 'Checking' } },
    ]);
    await session.updateTools(llm.ToolContext.empty());
    await session.updateTools(tools);
    expect(peer.settings.tools).toMatchObject([
      { function: { name: 'lookup' }, prism_filler: { text: 'Checking' } },
    ]);
    session.updateOptions({ toolFillers: {} });
    await session.updateTools(tools);
    expect(peer.settings.tools).toEqual(
      expect.arrayContaining([expect.not.objectContaining({ prism_filler: expect.anything() })]),
    );
  });
  it('queues option snapshots before subsequent replies and recovers after refusal', async () => {
    const { peer, model, session, errors } = await setupProgress();
    peer.onRequest = (q) => {
      if (q.session?.voice === 'refused') {
        peer.fault(q, 'invalid_voice');
        return true;
      }
      if (q.type === 'response.create') {
        peer.reply(q);
        return true;
      }
    };
    expect(model.updateOptions({ voice: 'first' })).toBeUndefined();
    model.updateOptions({ voice: 'refused' });
    model.updateOptions({ voice: 'last' });
    await session.generateReply();
    expect(peer.settings.voice).toBe('last');
    expect(errors).toHaveLength(1);
    expect(errors[0]?.recoverable).toBe(true);
    expect(peer.requests.filter((q) => q.session?.voice).map((q) => q.session?.voice)).toEqual([
      'first',
      'refused',
      'last',
    ]);
    expect(peer.requests.at(-1)?.type).toBe('response.create');
    await session.commitAudio();
    expect(session.isClosed).toBe(false);
    await session.close();
    expect(() => session.updateOptions({ voice: 'after-close' })).toThrow('closed');
  });
  it('configures copied options before the first session opens', async () => {
    const peer = await new PrismPeer().start();
    cleanup.push(() => peer.close());
    const model = new RealtimeModel({ apiKey: 'test', endpoint: peer.endpoint });
    cleanup.push(() => model.close());
    const options = { voice: 'before-open', responseMetadata: { stage: 'initial' } };
    model.updateOptions(options);
    options.responseMetadata.stage = 'mutated';
    await model.session().updateInstructions('Test');
    expect(peer.settings).toMatchObject({
      voice: 'before-open',
      prism_response_metadata: { stage: 'initial' },
    });
  });
  it.each([false, true])(
    'supports repeated standard RunContext updates with final error=%s',
    async (fail) => {
      const peer = await new PrismPeer().start();
      cleanup.push(() => peer.close());
      const model = new RealtimeModel({
        apiKey: 'test',
        endpoint: peer.endpoint,
        contextMode: 'strict',
      });
      cleanup.push(() => model.close());
      const session = new voice.AgentSession({
        llm: model,
        vad: null,
        aecWarmupDuration: null,
        turnHandling: { turnDetection: 'realtime_llm' },
      });
      session.output.audio = new TestAudioOutput();
      let finish!: () => void;
      const completed = new Promise<void>((resolve) => {
        finish = resolve;
      });
      const execute = vi.fn(async (_: unknown, { ctx }: { ctx: voice.RunContext }) => {
        await ctx.update('first progress');
        await ctx.update('silent progress', { silent: true });
        await ctx.update('second progress');
        finish();
        if (fail) throw new llm.ToolError('lookup failed');
        return 'final result';
      });
      await session.start({
        agent: new voice.Agent({
          instructions: 'Test',
          tools: {
            lookup: llm.tool({ description: 'Lookup', execute }),
          },
        }),
      });
      cleanup.push(() => session.close());
      let count = 0;
      peer.onRequest = (q) => {
        if (q.type !== 'response.create') return;
        const id = `reply-${++count}`;
        if (count === 1) {
          peer.accepted(q, id);
          peer.tool(id);
          peer.ended(id);
        } else {
          peer.reply(q, id);
          peer.history.push({
            id: `message-${id}`,
            type: 'message',
            role: 'assistant',
            text: 'Hello',
          });
        }
        return true;
      };
      const speech = session.generateReply({ userInput: 'Check' });
      await completed;
      await speech.waitForPlayout();
      await vi.waitFor(() =>
        expect(peer.history.filter((item) => item.type === 'function_call_output')).toHaveLength(4),
      );
      expect(execute).toHaveBeenCalledOnce();
      const outputs = peer.history
        .filter((item) => item.type === 'function_call_output')
        .map((item) => item.output);
      for (const text of [
        'first progress',
        'silent progress',
        'second progress',
        fail ? 'lookup failed' : 'final result',
      ])
        expect(outputs.filter((output) => output?.includes(text))).toHaveLength(1);
    },
  );

  it('accepts progress from two concurrent tools without repeating either execution', async () => {
    const peer = await new PrismPeer().start();
    cleanup.push(() => peer.close());
    const model = new RealtimeModel({
      apiKey: 'test',
      endpoint: peer.endpoint,
      contextMode: 'strict',
    });
    cleanup.push(() => model.close());
    const session = new voice.AgentSession({
      llm: model,
      vad: null,
      aecWarmupDuration: null,
      turnHandling: { turnDetection: 'realtime_llm' },
    });
    session.output.audio = new TestAudioOutput();
    const errors: llm.RealtimeModelError[] = [];
    const open = model.session.bind(model);
    vi.spyOn(model, 'session').mockImplementation((...args) => {
      const provider = open(...args);
      provider.on('error', (error) => errors.push(error));
      return provider;
    });
    let started = 0;
    let release!: () => void;
    const bothStarted = new Promise<void>((resolve) => {
      release = resolve;
    });
    const executions = new Map<string, number>();
    const tools = Object.fromEntries(
      ['one', 'two'].map((name) => [
        name,
        llm.tool({
          description: name,
          execute: async (_: unknown, { ctx }: { ctx: voice.RunContext }) => {
            executions.set(name, (executions.get(name) ?? 0) + 1);
            await ctx.update(`${name} started`);
            if (++started === 2) release();
            await bothStarted;
            await ctx.update(`${name} silent`, { silent: true });
            return `${name} completed`;
          },
        }),
      ]),
    );
    await session.start({ agent: new voice.Agent({ instructions: 'Test', tools }) });
    cleanup.push(() => session.close());
    let count = 0;
    peer.onRequest = (q) => {
      if (q.type !== 'response.create') return;
      const id = `concurrent-${++count}`;
      if (count === 1) {
        peer.accepted(q, id);
        peer.tool(id, 'call-one', 'one');
        peer.tool(id, 'call-two', 'two');
        peer.ended(id);
      } else {
        peer.reply(q, id);
        peer.history.push({
          id: `message-${id}`,
          type: 'message',
          role: 'assistant',
          text: 'Hello',
        });
      }
      return true;
    };
    await session.generateReply({ userInput: 'Run both tools' }).waitForPlayout();
    await vi.waitFor(() =>
      expect(peer.history.filter((item) => item.type === 'function_call_output')).toHaveLength(6),
    );
    expect([...executions.values()]).toEqual([1, 1]);
    for (const name of ['one', 'two'])
      for (const stage of ['started', 'silent', 'completed'])
        expect(
          peer.history.filter((item) => item.output?.includes(`${name} ${stage}`)),
        ).toHaveLength(1);
    expect(errors).toEqual([]);
  });

  it.each(['resource', 'input', 'admission'] as const)(
    'keeps the session usable after a local %s option refusal',
    async (kind) => {
      const { peer, session, errors } = await setupProgress();
      const types = await import('@rimelabs/sdk');
      const sdk = (session as unknown as { sdk: r.RealtimeSession }).sdk;
      const error =
        kind === 'resource'
          ? new types.RimeResourceLimitError('local limit')
          : kind === 'input'
            ? new types.RimeInputError('bad input')
            : new types.RealtimeAdmissionTimeout('not ready');
      vi.spyOn(sdk, 'update').mockRejectedValueOnce(error);
      session.updateOptions({ voice: 'refused' });
      session.updateOptions({ voice: 'accepted' });
      await session.updateInstructions('After options');
      expect(errors).toHaveLength(1);
      expect(errors[0]?.recoverable).toBe(true);
      expect(peer.settings.voice).toBe('accepted');
      expect(session.isClosed).toBe(false);
    },
  );
});

describe('OutputQueue', () => {
  it('throws when a push exceeds its limit', () => {
    const queue = new OutputQueue<number>(() => undefined, 2);
    queue.push(1);
    queue.push(2);
    expect(() => queue.push(3)).toThrow('Prism output exceeds 2 queued chunks');
  });
  it('keeps every unread chunk without a limit', async () => {
    const queue = new OutputQueue<number>(() => undefined);
    for (let i = 0; i < 1000; i++) queue.push(i);
    queue.close();
    expect(await collect(queue.stream)).toHaveLength(1000);
  });
});
