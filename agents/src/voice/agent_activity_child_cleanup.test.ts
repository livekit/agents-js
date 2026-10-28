// SPDX-FileCopyrightText: 2026 LiveKit, Inc.
//
// SPDX-License-Identifier: Apache-2.0
import { AgentSession as pb } from '@livekit/protocol';
import { AudioFrame } from '@livekit/rtc-node';
import { ReadableStream } from 'node:stream/web';
import { beforeAll, expect, it, vi } from 'vitest';
import { ChatContext, ChatMessage, type FunctionCall } from '../llm/chat_context.js';
import {
  type GenerationCreatedEvent,
  type MessageGeneration,
  RealtimeModel,
  RealtimeSession,
} from '../llm/realtime.js';
import { ToolContext } from '../llm/tool_context.js';
import { initializeLogger } from '../log.js';
import { TTS } from '../tts/tts.js';
import { Future, Task, delay } from '../utils.js';
import { Agent } from './agent.js';
import { AgentSession } from './agent_session.js';
import { AudioOutput, TextOutput } from './io.js';
import { SessionHost } from './remote_session.js';
import { REPLY_TASK_CANCEL_TIMEOUT } from './speech_handle.js';
import { FakeLLM } from './testing/fake_llm.js';
import { InMemoryTransport, request } from './testing/remote_session.js';
import type { RunResult } from './testing/run_result.js';

beforeAll(() => initializeLogger({ pretty: false, level: 'warn' }));

function stream<T>(...values: T[]): ReadableStream<T> {
  return new ReadableStream<T>({
    start(controller) {
      values.forEach((value) => controller.enqueue(value));
      controller.close();
    },
  });
}

class ControlledRealtimeSession extends RealtimeSession {
  chatCtx = ChatContext.empty();
  tools = ToolContext.empty();
  private generations = 0;
  async updateInstructions() {}
  async updateChatCtx(context: ChatContext) {
    this.chatCtx = context;
  }
  async updateTools(tools: ToolContext) {
    this.tools = tools;
  }
  updateOptions() {}
  pushAudio() {}
  async generateReply(): Promise<GenerationCreatedEvent> {
    return {
      userInitiated: true,
      messageStream: stream({
        messageId: `message-${++this.generations}`,
        textStream: stream('source'),
        audioStream: stream<AudioFrame>(),
        modalities: Promise.resolve<Array<'text' | 'audio'>>(['text']),
      }),
      functionStream: stream<FunctionCall>(),
    };
  }
  async commitAudio() {}
  async clearAudio() {}
  async interrupt() {}
  async truncate() {}
}

class ControlledRealtimeModel extends RealtimeModel {
  constructor() {
    super({
      messageTruncation: false,
      turnDetection: false,
      userTranscription: false,
      autoToolReplyGeneration: false,
      audioOutput: false,
      manualFunctionCalls: true,
    });
  }
  get model() {
    return 'controlled';
  }
  session() {
    return new ControlledRealtimeSession(this);
  }
  async close() {}
}

class HookTTS extends TTS {
  label = 'controlled';
  constructor() {
    super(24000, 1, { streaming: true });
  }
  synthesize(): never {
    throw new Error('Use the agent TTS hook');
  }
  stream(): never {
    throw new Error('Use the agent TTS hook');
  }
}

class Text extends TextOutput {
  ready = new Future<void>();
  flushes: (Task<unknown> | undefined)[] = [];
  override async captureText() {
    this.ready.resolve();
  }
  override flush() {
    this.flushes.push(Task.current());
  }
}

class Audio extends AudioOutput {
  ready = new Future<void>();
  constructor() {
    super(24000);
  }
  override async captureFrame(frame: AudioFrame) {
    await super.captureFrame(frame);
    this.onPlaybackStarted(Date.now());
    this.ready.resolve();
  }
  override flush() {
    super.flush();
    if (this.pendingPlayoutSegments)
      this.onPlaybackFinished({ playbackPosition: 0.02, interrupted: false });
  }
  override clearBuffer() {
    if (this.pendingPlayoutSegments)
      this.onPlaybackFinished({ playbackPosition: 0.02, interrupted: true });
  }
}

it.each(
  (['generated', 'realtime'] as const).flatMap((mode) =>
    (['resolve', 'reject', 'host close', 'immediate'] as const).map((ending) => ({
      mode,
      ending,
    })),
  ),
)(
  'retains $mode child cleanup through $ending before admitting another run',
  async ({ mode, ending }) => {
    const release = new Future<void>();
    const cancelling = new Future<void>();
    const cancel = vi.fn(() => {
      cancelling.resolve();
      return release.await;
    });
    let transcriptions = 0;
    class TestAgent extends Agent {
      override async transcriptionNode(input: Parameters<Agent['transcriptionNode']>[0]) {
        if (mode === 'generated') return input;
        if (++transcriptions > 1) return stream('fresh reply');
        return new ReadableStream<string>({
          start(controller) {
            controller.enqueue('old prefix');
          },
          cancel,
        });
      }
      override async ttsNode() {
        return new ReadableStream<AudioFrame>({
          start(controller) {
            controller.enqueue(new AudioFrame(new Int16Array(480), 24000, 1, 480));
          },
          cancel,
        });
      }
    }
    const tasks: Task<unknown>[] = [];
    const from = Task.from;
    const spy = vi.spyOn(Task, 'from').mockImplementation((fn, controller, name) => {
      const task = from.call(Task, fn, controller, name);
      tasks.push(task);
      return task;
    });
    const session = new AgentSession({
      llm:
        mode === 'realtime'
          ? new ControlledRealtimeModel()
          : new FakeLLM([
              { input: 'go', content: 'old generated' },
              { input: 'fresh', content: 'fresh reply' },
            ]),
      tts: mode === 'generated' ? new HookTTS() : undefined,
      vad: null,
      useTtsAlignedTranscript: false,
    });
    const text = new Text();
    const audio = new Audio();
    session.output.transcription = text;
    if (mode === 'generated') session.output.audio = audio;
    const transport = new InMemoryTransport();
    const host = new SessionHost(transport);
    let run: RunResult | undefined;
    let cancellation: Promise<void> | undefined;
    let closing: Promise<void> | undefined;
    let prematureRun: RunResult | undefined;
    try {
      await session.start({ agent: new TestAgent({ instructions: 'test' }) });
      if (ending === 'host close') {
        host.registerSession(session);
        await host.start();
        transport.push(
          request('held', {
            case: 'runInput',
            value: new pb.SessionRequest_RunInput({ text: 'go' }),
          }),
        );
      } else {
        run = session.run({ userInput: 'go' });
      }
      await (mode === 'generated' ? audio.ready.await : text.ready.await);
      run ??= session._globalRunState;
      expect(run).toBeDefined();
      void run!.wait().catch(() => {});
      const oldChildren = tasks.filter((task) =>
        [
          'performTextForwarding',
          'performTTSInference',
          'AgentActivity.realtime_generation.process_messages',
        ].includes(task.name ?? ''),
      );
      expect(oldChildren.length).toBeGreaterThan(0);
      let settled = false;
      if (ending === 'host close') {
        closing = host.close();
        await cancelling.await;
      }
      cancellation = run!._cancel();
      void cancellation.then(() => (settled = true));
      await cancelling.await;
      if (ending === 'immediate') {
        release.resolve();
        await cancellation;
      } else if (closing) {
        await closing;
        expect(transport.closed).toBe(true);
      } else {
        await delay(REPLY_TASK_CANCEL_TIMEOUT + 400);
      }
      if (ending !== 'immediate') {
        expect.soft(settled).toBe(false);
        expect.soft(session._globalRunState === run).toBe(true);
        expect(oldChildren.some((task) => !task.done)).toBe(true);
      }
      const wireCount = transport.sent.length;
      session.output.audio = null;
      let firstFreshFlush = text.flushes.length;
      if (ending !== 'immediate') {
        let admissionError: unknown;
        try {
          prematureRun = session.run({ userInput: 'fresh' });
        } catch (error) {
          admissionError = error;
        }
        expect.soft(admissionError).toMatchObject({ message: 'nested runs are not supported' });
        await prematureRun?.wait();
      }
      if (ending === 'reject') release.reject(new Error('late child cleanup failed'));
      else release.resolve();
      await cancellation;
      await Promise.allSettled(oldChildren.map((task) => task.result));
      expect(oldChildren.every((task) => task.done)).toBe(true);
      expect(cancel).toHaveBeenCalledOnce();
      if (mode === 'realtime') {
        expect
          .soft(
            session.history.items.some(
              (item) =>
                item.type === 'message' && item.textContent === 'old prefix' && item.interrupted,
            ),
          )
          .toBe(true);
      }
      if (!prematureRun) firstFreshFlush = text.flushes.length;
      const fresh = prematureRun ?? session.run({ userInput: 'fresh' });
      await fresh.wait();
      fresh.expect.nextEvent().isMessage({ role: 'assistant', textContent: 'fresh reply' });
      fresh.expect.noMoreEvents();
      expect
        .soft(text.flushes.slice(firstFreshFlush).some((task) => oldChildren.includes(task!)))
        .toBe(false);
      if (ending === 'host close') expect(transport.sent.length).toBe(wireCount);
    } finally {
      release.resolve();
      await cancellation;
      await closing;
      await host.close();
      await prematureRun?.wait();
      await session.close();
      spy.mockRestore();
    }
  },
  12000,
);

it('releases preemptive synthesis streams when cancelled before scheduling', async () => {
  const entered = new Future<void>();
  const tasks: Task<unknown>[] = [];
  const from = Task.from;
  const spy = vi.spyOn(Task, 'from').mockImplementation((fn, controller, name) => {
    const task = from.call(Task, fn, controller, name);
    tasks.push(task);
    return task;
  });
  class TestAgent extends Agent {
    override async ttsNode() {
      entered.resolve();
      return stream(new AudioFrame(new Int16Array(480), 24000, 1, 480));
    }
  }
  const session = new AgentSession({
    llm: new FakeLLM([{ input: 'go', content: 'source' }]),
    tts: new HookTTS(),
    vad: null,
    turnHandling: {
      turnDetection: 'manual',
      preemptiveGeneration: { enabled: true, preemptiveTts: true },
    },
  });
  session.output.audio = new Audio();
  try {
    await session.start({ agent: new TestAgent({ instructions: 'test' }) });
    const speech = session._activity!.generateReply({
      userMessage: ChatMessage.create({ role: 'user', content: 'go' }),
      scheduleSpeech: false,
    });
    await entered.await;
    await new Promise<void>((resolve) => setImmediate(resolve));
    const synthesis = tasks.find((task) => task.name === 'performTTSInference');
    const producer = tasks.find(
      (task) => task.name === 'AgentActivity.pipelineReply.produceSegments',
    );
    expect(synthesis).toBeDefined();
    expect(producer).toBeDefined();
    speech.interrupt(true);
    await expect
      .poll(() => synthesis!.done && producer!.done && speech._tasks.every((task) => task.done), {
        timeout: 3000,
      })
      .toBe(true);
  } finally {
    await session.close();
    spy.mockRestore();
  }
}, 10000);

it('cancels pending realtime message and function reads before joining speech cleanup', async () => {
  let messages: ReadableStreamDefaultController<MessageGeneration> | undefined;
  let functions: ReadableStreamDefaultController<FunctionCall> | undefined;
  const cancelMessages = vi.fn(() => {
    messages = undefined;
  });
  const cancelFunctions = vi.fn(() => {
    functions = undefined;
  });
  class OpenSession extends ControlledRealtimeSession {
    override async generateReply(): Promise<GenerationCreatedEvent> {
      return {
        userInitiated: true,
        messageStream: new ReadableStream<MessageGeneration>({
          start(controller) {
            messages = controller;
            controller.enqueue({
              messageId: 'held',
              textStream: stream('prefix'),
              audioStream: stream<AudioFrame>(),
              modalities: Promise.resolve<Array<'audio' | 'text'>>(['text']),
            });
          },
          cancel: cancelMessages,
        }),
        functionStream: new ReadableStream<FunctionCall>({
          start(controller) {
            functions = controller;
          },
          cancel: cancelFunctions,
        }),
      };
    }
  }
  class OpenModel extends ControlledRealtimeModel {
    override session() {
      return new OpenSession(this);
    }
  }
  const session = new AgentSession({ llm: new OpenModel(), vad: null });
  const text = new Text();
  session.output.transcription = text;
  let cancellation: Promise<void> | undefined;
  try {
    await session.start({ agent: new Agent({ instructions: 'test' }) });
    const run = session.run({ userInput: 'go' });
    void run.wait().catch(() => {});
    await text.ready.await;
    await new Promise<void>((resolve) => setImmediate(resolve));
    let settled = false;
    cancellation = run._cancel();
    void cancellation.then(() => (settled = true));
    await expect.poll(() => settled, { timeout: 1000 }).toBe(true);
    expect(cancelMessages).toHaveBeenCalledOnce();
    expect(cancelFunctions).toHaveBeenCalledOnce();
    await cancellation;
  } finally {
    messages?.close();
    functions?.close();
    await cancellation;
    await session.close();
  }
});
