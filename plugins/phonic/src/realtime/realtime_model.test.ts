// SPDX-FileCopyrightText: 2026 LiveKit, Inc.
//
// SPDX-License-Identifier: Apache-2.0
import { Future, initializeLogger, llm, voice } from '@livekit/agents';
import { EventEmitter } from 'node:events';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ServerEvent } from './api_proto.js';
import { RealtimeModel, type RealtimeSession } from './realtime_model.js';

const { connect } = vi.hoisted(() => ({ connect: vi.fn() }));
vi.mock('phonic', () => ({
  PhonicClient: class {
    conversations = { connect };
  },
}));

initializeLogger({ pretty: false, level: 'silent' });

class FakeSocket extends EventEmitter {
  waitForOpen = vi.fn(async () => {});
  sendConfig = vi.fn(() => {
    queueMicrotask(() => this.receive({ type: 'ready_to_start_conversation' }));
  });
  sendToolCallOutput = vi.fn();
  sendGenerateReply = vi.fn();
  sendReset = vi.fn();
  close = vi.fn();

  receive(message: ServerEvent): void {
    this.emit('message', message);
  }

  callTool(): void {
    this.receive({
      type: 'tool_call',
      tool_call_id: 'call_1',
      tool_name: 'advance',
      parameters: {},
    });
  }

  reply(text: string, speechStarted = true): void {
    if (speechStarted) this.receive({ type: 'assistant_started_speaking' });
    this.receive({ type: 'audio_chunk', text, audio: Buffer.alloc(960, 1).toString('base64') });
    this.receive({ type: 'assistant_finished_speaking' });
  }
}

describe('Phonic post-tool generations', () => {
  let socket: FakeSocket;
  let model: RealtimeModel;
  let realtime: RealtimeSession;
  let session: voice.AgentSession | undefined;

  beforeEach(() => {
    socket = new FakeSocket();
    connect.mockResolvedValue(socket);
    model = new RealtimeModel({ apiKey: 'test-key' });
    session = undefined;
  });

  afterEach(async () => {
    // Settle a generation even when an assertion fails, so a regression does not
    // leave session.close() waiting for the very speech this test is exercising.
    socket.receive({ type: 'assistant_finished_speaking' });
    await session?.close();
    await realtime?.close();
  });

  async function startRealtime(): Promise<void> {
    realtime = model.session();
    await realtime.updateInstructions('Help the caller.');
    await realtime.updateTools(llm.ToolContext.empty());
    await vi.waitFor(() => expect(socket.sendConfig).toHaveBeenCalledOnce());
  }

  async function sendToolResult(replyRequired = true): Promise<void> {
    socket.callTool();
    const ctx = realtime.chatCtx;
    ctx.items.push(
      llm.FunctionCallOutput.create({
        name: 'advance',
        callId: 'call_1',
        output: 'continue',
        isError: false,
        replyRequired,
      }),
    );
    await realtime.updateChatCtx(ctx);
  }

  it.each([true, false])(
    'delivers a tool result without reserving speech (replyRequired=%s)',
    async (replyRequired) => {
      await startRealtime();
      const generations = vi.fn();
      realtime.on('generation_created', generations);
      await sendToolResult(replyRequired);

      expect(socket.sendToolCallOutput).toHaveBeenCalledExactlyOnceWith({
        type: 'tool_call_output',
        tool_call_id: 'call_1',
        output: 'continue',
      });
      expect(generations).toHaveBeenCalledTimes(1); // only the tool-call generation
      expect(realtime.chatCtx.items.at(-1)).toMatchObject({
        type: 'function_call_output',
        callId: 'call_1',
      });
      // Context synchronization must not re-send an already answered tool call.
      await realtime.updateChatCtx(realtime.chatCtx);
      expect(socket.sendToolCallOutput).toHaveBeenCalledOnce();
    },
  );

  it.each([true, false])(
    'opens one reply on server speech, including the text fallback (speechStarted=%s)',
    async (speechStarted) => {
      await startRealtime();
      await sendToolResult();
      const generations = vi.fn();
      realtime.on('generation_created', generations);

      // Phonic also streams background/silence audio between utterances.
      socket.receive({
        type: 'audio_chunk',
        audio: Buffer.alloc(960).toString('base64'),
        text: '',
      });
      expect(generations).not.toHaveBeenCalled();
      socket.reply('Please tell me more.', speechStarted);

      expect(generations).toHaveBeenCalledOnce();
      const event = generations.mock.calls[0]![0] as llm.GenerationCreatedEvent;
      const message = (await event.messageStream.getReader().read()).value!;
      const text = (await message.textStream.getReader().read()).value;
      expect(text).toMatchObject({ text: 'Please tell me more.' });
      const audio = (await message.audioStream.getReader().read()).value!;
      expect(audio.samplesPerChannel).toBe(480);
      expect(audio.sampleRate).toBe(24000);
      expect(realtime.chatCtx.items.at(-1)?.type).toBe('message');
    },
  );

  it('resolves an explicit post-tool generateReply only when the server responds', async () => {
    await startRealtime();
    await sendToolResult();
    const generations = vi.fn();
    realtime.on('generation_created', generations);
    const reply = realtime.generateReply('Ask one follow-up question.');
    await vi.waitFor(() =>
      expect(socket.sendGenerateReply).toHaveBeenCalledExactlyOnceWith({
        type: 'generate_reply',
        system_message: 'Ask one follow-up question.',
      }),
    );
    expect(generations).not.toHaveBeenCalled();
    socket.reply('Please tell me more.');
    expect(await reply).toMatchObject({ userInitiated: true });
    expect(generations).toHaveBeenCalledOnce();
  });

  async function startAgent(agent: voice.Agent): Promise<void> {
    session = new voice.AgentSession({ llm: model, vad: null });
    await session.start({ agent });
    realtime = model._activeSession!;
    await vi.waitFor(() => expect(socket.sendConfig).toHaveBeenCalledOnce());
  }

  it('keeps session.run open for a delayed automatic reply and records it', async () => {
    await startAgent(
      new voice.Agent({
        instructions: 'Help the caller.',
        tools: { advance: llm.tool({ description: 'Continue.', execute: async () => 'continue' }) },
      }),
    );
    const run = session!.run({ userInput: 'Continue, please.' });
    await vi.waitFor(() => expect(socket.sendGenerateReply).toHaveBeenCalledOnce());
    socket.callTool();
    await vi.waitFor(() => expect(socket.sendToolCallOutput).toHaveBeenCalledOnce());
    // Let the tool task finish before the provider responds. RunResult must keep
    // watching for the next generation, rather than finish at the tool result.
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(run.done()).toBe(false);
    socket.reply('Please tell me more.');
    await run.wait();
    expect(
      run.events.some(
        (event) => event.type === 'message' && event.item.textContent === 'Please tell me more.',
      ),
    ).toBe(true);
  });

  it('settles session.run after the existing timeout when no automatic reply arrives', async () => {
    await startAgent(
      new voice.Agent({
        instructions: 'Help the caller.',
        tools: { advance: llm.tool({ description: 'Continue.', execute: async () => 'continue' }) },
      }),
    );
    const run = session!.run({ userInput: 'Continue, please.' });
    await vi.waitFor(() => expect(socket.sendGenerateReply).toHaveBeenCalledOnce());
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    try {
      socket.callTool();
      await vi.waitFor(() => expect(socket.sendToolCallOutput).toHaveBeenCalledOnce());
      expect(run.done()).toBe(false);
      await vi.advanceTimersByTimeAsync(5001);
      await run.wait();
      expect(run.events.filter((event) => event.type === 'message')).toEqual([]);
    } finally {
      vi.useRealTimers();
    }
  });

  it('still drains outgoing speech that actually started before the handoff', async () => {
    const exiting = new Future<void>();
    class OutgoingAgent extends voice.Agent {
      async onExit(): Promise<void> {
        exiting.resolve();
      }
    }
    await startAgent(new OutgoingAgent({ instructions: 'Help the caller.' }));
    socket.receive({ type: 'assistant_started_speaking' });
    socket.receive({ type: 'audio_chunk', text: 'Thanks.', audio: '' });
    session!.updateAgent(new voice.Agent({ instructions: 'Ask the next question.' }));
    await exiting.await;
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(socket.sendReset).not.toHaveBeenCalled();

    socket.receive({ type: 'assistant_finished_speaking' });
    await vi.waitFor(() => expect(socket.sendReset).toHaveBeenCalledOnce());
    expect(
      session!.history.items.some(
        (item) => item.type === 'message' && item.textContent === 'Thanks.',
      ),
    ).toBe(true);
  });

  it.each(['tool result first', 'handoff first'])(
    'resets without waiting for unstarted speech (%s)',
    async (ordering) => {
      const exiting = new Future<void>();
      const releaseExit = new Future<void>();
      const nextEntered = new Future<void>();
      class NextAgent extends voice.Agent {
        async onEnter(): Promise<void> {
          nextEntered.resolve();
        }
      }
      const next = new NextAgent({ instructions: 'Ask the next question.' });
      class OutgoingAgent extends voice.Agent {
        async onExit(): Promise<void> {
          exiting.resolve();
          await releaseExit.await;
        }
      }
      await startAgent(
        new OutgoingAgent({
          instructions: 'Help the caller.',
          tools: {
            advance: llm.tool({
              description: 'Continue.',
              execute: async () => {
                if (ordering === 'handoff first') session!.updateAgent(next);
                return 'continue';
              },
            }),
          },
        }),
      );

      try {
        socket.callTool();
        await vi.waitFor(() => expect(socket.sendToolCallOutput).toHaveBeenCalledOnce());
        // updateAgent blocks new turns synchronously. The race is whether the
        // plugin has already reserved speech before that handoff decision arrives.
        if (ordering === 'tool result first') session!.updateAgent(next);
        await exiting.await;
        releaseExit.resolve();
        await vi.waitFor(() => expect(socket.sendReset).toHaveBeenCalledOnce());
        await nextEntered.await;

        const speech = session!.generateReply();
        await vi.waitFor(() => expect(socket.sendGenerateReply).toHaveBeenCalledOnce());
        socket.reply('What would you like to discuss next?');
        await speech.waitForPlayout();
        expect(
          session!.history.items.flatMap((item) =>
            item.type === 'message' && item.role === 'assistant' ? [item.textContent] : [],
          ),
        ).toEqual(['What would you like to discuss next?']);
      } finally {
        releaseExit.resolve();
      }
    },
  );
});
