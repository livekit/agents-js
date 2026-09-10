// SPDX-FileCopyrightText: 2026 LiveKit, Inc.
//
// SPDX-License-Identifier: Apache-2.0
import { AudioFrame } from '@livekit/rtc-node';
import { ReadableStream, type ReadableStreamDefaultController } from 'node:stream/web';
import { setImmediate } from 'node:timers/promises';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { log } from '../log.js';
import type { RealtimeModelMetrics } from '../metrics/base.js';
import { Agent } from '../voice/agent.js';
import { AgentSession } from '../voice/agent_session.js';
import { AgentSessionEventTypes, CloseReason } from '../voice/events.js';
import { type TimedString, isTimedString } from '../voice/io.js';
import { ChatContext, type ChatItem, FunctionCall, FunctionCallOutput } from './chat_context.js';
import { type DuplexAudioFrame, DuplexModel, DuplexSession } from './duplex.js';
import {
  AdaptiveNoiseGate,
  DuplexRealtimeAdapter,
  DuplexRealtimeSession,
  FixedGate,
} from './duplex_adapter.js';
import type { DuplexRealtimeAdapterOptions } from './duplex_adapter.js';
import { type GenerationCreatedEvent, RealtimeError, type RealtimeModelError } from './realtime.js';
import { type ToolChoice, ToolContext } from './tool_context.js';

function frame(level: number, duration = 100): AudioFrame {
  const samples = new Int16Array((24_000 * duration) / 1000);
  const amplitude = Math.trunc(level * 32767);
  for (let i = 0; i < samples.length; i++) samples[i] = i % 2 ? -amplitude : amplitude;
  return new AudioFrame(samples, 24_000, 1, samples.length);
}

class FakeDuplexModel extends DuplexModel {
  activeSession!: FakeDuplexSession;
  askable = false;
  constructor() {
    super({ userTranscription: true, autoToolReplyGeneration: true });
  }
  get model() {
    return 'fake-duplex';
  }
  get provider() {
    return 'fake';
  }
  session(): FakeDuplexSession {
    return (this.activeSession = new FakeDuplexSession(this));
  }
  async close(): Promise<void> {}
}

class FakeDuplexSession extends DuplexSession {
  private readonly connectionTask = this._configured.wait().then(() => {
    if (!this._closing) this.connected = true;
  });
  controller!: ReadableStreamDefaultController<DuplexAudioFrame>;
  readonly audioStream = new ReadableStream<DuplexAudioFrame>({
    start: (controller) => {
      this.controller = controller;
    },
  });
  tools = ToolContext.empty();
  appended: ChatItem[] = [];
  configBatches: unknown[][] = [];
  repliesRequested: Array<string | undefined> = [];
  connected = false;
  closed = false;
  constructor(readonly fakeModel: FakeDuplexModel) {
    super(fakeModel);
  }
  get configured(): boolean {
    return this._configured.isSet;
  }
  async _updateInstructions(_instructions: string): Promise<void> {}
  async _appendItems(items: ChatItem[]): Promise<void> {
    this.appended.push(...items);
  }
  async _updateTools(tools: ToolContext): Promise<void> {
    this.tools = tools;
  }
  _updateOptions(_options: { toolChoice?: ToolChoice | null }): void {}
  pushAudio(_frame: AudioFrame): void {}
  protected async closeConnection(): Promise<void> {
    await this.connectionTask;
    if (!this.closed) this.controller.close();
    this.closed = true;
  }
  _generateReply(instructions?: string): void {
    if (!this.fakeModel.askable) super._generateReply(instructions);
    this.repliesRequested.push(instructions);
  }
  async _updateSession(
    instructions?: string,
    chatCtx?: ChatContext,
    tools?: ToolContext,
  ): Promise<void> {
    this.configBatches.push([instructions, chatCtx, tools]);
    await super._updateSession(instructions, chatCtx, tools);
  }
  reportConnectionAcquired(duration: number): void {
    this._reportConnectionAcquired(duration);
  }
  push(level: number, count = 1, startMs?: number): void {
    for (let i = 0; i < count; i++) {
      this.controller.enqueue({
        frame: frame(level),
        startMs: startMs === undefined ? undefined : startMs + i * 100,
      });
    }
  }
  say(text: string, startMs?: number, endMs?: number): void {
    this.emit('transcript_delta', { text, startMs, endMs });
  }
  heard(itemId: string, transcript: string): void {
    this.emit('input_speech_started', {});
    this.emit('input_audio_transcription_completed', { itemId, transcript, isFinal: true });
    this.emit('input_speech_stopped', { userTranscriptionEnabled: false });
  }
}

const sessions: DuplexRealtimeSession[] = [];
afterEach(async () => {
  await Promise.all(sessions.splice(0).map((session) => session.close()));
  vi.useRealTimers();
  vi.restoreAllMocks();
});

function setup(options: DuplexRealtimeAdapterOptions = {}, model = new FakeDuplexModel()) {
  const adapter = new DuplexRealtimeAdapter(model, options);
  const session = adapter.session();
  if (!(session instanceof DuplexRealtimeSession)) throw new Error('expected duplex session');
  sessions.push(session);
  const generations: GenerationCreatedEvent[] = [];
  session.on('generation_created', (ev) => generations.push(ev));
  return { model, adapter, fake: model.activeSession, session, generations };
}

async function readGeneration(ev: GenerationCreatedEvent) {
  const chunks: Array<string | TimedString> = [];
  const frames: AudioFrame[] = [];
  const messages = [];
  for await (const message of ev.messageStream) {
    messages.push(message);
    for await (const f of message.audioStream) frames.push(f);
    for await (const chunk of message.textStream) chunks.push(chunk);
  }
  const functions = [];
  for await (const call of ev.functionStream) functions.push(call);
  return {
    frames,
    chunks,
    messages,
    functions,
    text: chunks.map((chunk) => (isTimedString(chunk) ? chunk.text : chunk)).join(''),
  };
}

describe('duplex audio gates', () => {
  it.each([0, 0.02])('stays closed on a steady floor of %s', (level) => {
    const gate = new AdaptiveNoiseGate();
    for (let i = 0; i < 40; i++) expect(gate.update(frame(level))).toBe(false);
  });

  it('opens above room tone and holds through short quiet gaps', () => {
    const gate = new AdaptiveNoiseGate({ minSilenceDuration: 250 });
    for (let i = 0; i < 30; i++) gate.update(frame(0.001));
    expect(gate.update(frame(0.3))).toBe(true);
    expect(gate.update(frame(0.001))).toBe(true);
    expect(gate.update(frame(0.001))).toBe(true);
    expect(gate.update(frame(0.001))).toBe(false);
  });

  it.each([false, true])('does not learn sustained speech as silence (gaps: %s)', (gaps) => {
    const gate = new AdaptiveNoiseGate({ window: 1000 });
    for (let i = 0; i < 30; i++) gate.update(frame(0.002));
    for (let i = 0; i < 400; i++) {
      expect(gate.update(frame(gaps && i % 10 === 9 ? 0.003 : 0.3))).toBe(true);
    }
    expect(gate.update(frame(0.3))).toBe(true);
    for (let i = 0; i < 4; i++) expect(gate.update(frame(0.002))).toBe(true);
    expect(gate.update(frame(0.002))).toBe(false);
    expect(gate.update(frame(0.3))).toBe(true);
  });

  it('does not learn its floor from one dropped frame', () => {
    const gate = new AdaptiveNoiseGate();
    for (let i = 0; i < 30; i++) gate.update(frame(0.002));
    gate.update(frame(0));
    for (let i = 0; i < 300; i++) expect(gate.update(frame(0.002))).toBe(false);
  });

  it('recovers when a session starts mid-speech', () => {
    const gate = new AdaptiveNoiseGate();
    for (let i = 0; i < 30; i++) expect(gate.update(frame(0.2))).toBe(false);
    for (let i = 0; i < 20; i++) gate.update(frame(0.002));
    expect(gate.update(frame(0.2))).toBe(true);
  });

  it('uses a declared silence without learning and ignores room tone', () => {
    const gate = new FixedGate(0.02);
    for (let i = 0; i < 40; i++) expect(gate.update(frame(0.02))).toBe(false);
    for (let i = 0; i < 600; i++) expect(gate.update(frame(0.3))).toBe(true);
    for (let i = 0; i < 5; i++) gate.update(frame(0.02));
    expect(gate.update(frame(0.02))).toBe(false);
    expect(new FixedGate(0.002).update(frame(0.2))).toBe(true);
  });

  it('uses audio duration rather than frame count', () => {
    const levels = [
      ...Array<number>(12).fill(0.001),
      ...Array<number>(6).fill(0.3),
      ...Array<number>(12).fill(0.001),
    ];
    const decisions = [20, 100].map((duration) => {
      const gate = new AdaptiveNoiseGate({ window: 1000, minSilenceDuration: 450 });
      return levels.map((level) => {
        let open = false;
        for (let i = 0; i < 100 / duration; i++) open = gate.update(frame(level, duration));
        return open;
      });
    });
    expect(decisions[0]).toEqual(decisions[1]);
    expect(decisions[0]![12]).toBe(true);
    expect(decisions[0]!.at(-1)).toBe(false);
  });

  it.each([FixedGate, AdaptiveNoiseGate])(
    'deactivates without forgetting the floor: %s',
    (Gate) => {
      const gate = Gate === FixedGate ? new FixedGate(0.002) : new AdaptiveNoiseGate();
      for (let i = 0; i < 20; i++) gate.update(frame(0.002));
      expect(gate.update(frame(0.3))).toBe(true);
      gate.deactivate();
      expect(gate.update(frame(0.002))).toBe(false);
      expect(gate.update(frame(0.3))).toBe(true);
    },
  );
});

describe('duplex segmentation', () => {
  it('prefers an explicit gate, then the model gate, then an adaptive gate', async () => {
    const model = new FakeDuplexModel();
    const inferred = setup({}, model);
    inferred.fake.push(0.3);
    await setImmediate();
    expect(inferred.generations).toHaveLength(0);
    vi.spyOn(model, 'audioGate').mockImplementation(() => new FixedGate(0.002));
    const declared = setup({}, model);
    declared.fake.push(0.3);
    await setImmediate();
    expect(declared.generations).toHaveLength(1);
    const explicit = setup({ gate: () => new AdaptiveNoiseGate() }, model);
    explicit.fake.push(0.3);
    await setImmediate();
    expect(explicit.generations).toHaveLength(0);
  });

  it('closes a burst when frames stop arriving, including the last frame duration', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const { fake, generations } = setup({ audioTimeout: 50 });
    fake.push(0.001, 20);
    fake.push(0.3, 3);
    await setImmediate();
    const read = readGeneration(generations[0]!);
    let finished = false;
    void read.then(() => {
      finished = true;
    });
    await vi.advanceTimersByTimeAsync(149);
    expect(finished).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    expect((await read).frames).toHaveLength(3);
    fake.push(0.3, 3);
    await setImmediate();
    expect(generations).toHaveLength(2);
  });

  it('does not produce a generation from silence', async () => {
    const { fake, generations } = setup();
    fake.push(0, 20);
    await setImmediate();
    expect(generations).toEqual([]);
  });

  it('plays untranscribed backchannels without creating a chat item', async () => {
    const { fake, session, generations } = setup();
    fake.push(0.001, 20);
    fake.push(0.3, 3);
    fake.push(0.001, 8);
    await setImmediate();
    expect(generations).toHaveLength(1);
    const result = await readGeneration(generations[0]!);
    expect(result.frames).toHaveLength(7);
    expect(result.text).toBe('');
    expect(session.chatCtx.items).toEqual([]);
  });

  it('creates two generations for two stretches of speech', async () => {
    const { fake, generations } = setup();
    fake.push(0.001, 20);
    for (let i = 0; i < 2; i++) {
      fake.push(0.3, 3);
      fake.push(0.001, 8);
    }
    await setImmediate();
    expect(generations).toHaveLength(2);
    expect(generations[0]!.responseId).not.toBe(generations[1]!.responseId);
  });

  it('preserves pauses inside an utterance', async () => {
    const { fake, generations } = setup();
    fake.push(0.001, 20);
    fake.push(0.3, 3);
    fake.push(0.001, 3);
    fake.push(0.3, 3);
    fake.push(0.001, 8);
    await setImmediate();
    expect(generations).toHaveLength(1);
    expect((await readGeneration(generations[0]!)).frames).toHaveLength(13);
  });

  it('joins transcript fragments to the open burst', async () => {
    const { fake, generations } = setup();
    fake.push(0.001, 20);
    fake.push(0.3, 2);
    await setImmediate();
    fake.say('Sure,', 2000, 2200);
    fake.push(0.3, 2);
    fake.say(' I can.', 2200, 2400);
    fake.push(0.001, 8);
    await setImmediate();
    expect((await readGeneration(generations[0]!)).text).toBe('Sure, I can.');
  });

  it.each([false, true])(
    'anchors timed text to the burst onset (stamped audio: %s)',
    async (stamped) => {
      const { fake, generations } = setup();
      fake.push(0.001, 20, stamped ? 5000 : undefined);
      fake.push(0.3, 2, stamped ? 7000 : undefined);
      await setImmediate();
      fake.say('hello', 7000, 7200);
      fake.say(' there', 7200, 7400);
      fake.push(0.3, 3, stamped ? 7200 : undefined);
      await fake.close();
      await setImmediate();
      const { chunks } = await readGeneration(generations[0]!);
      expect(chunks).toMatchObject([
        { text: 'hello', startTime: 0, endTime: 0.2 },
        { text: ' there', startTime: 0.2, endTime: 0.4 },
      ]);
    },
  );

  it('waits for sound when its transcript arrives first', async () => {
    const { fake, generations } = setup();
    fake.push(0.001, 20);
    await setImmediate();
    fake.say(' Sure.', 2000, 2200);
    fake.push(0.001, 5);
    await setImmediate();
    expect(generations).toHaveLength(0);
    fake.push(0.3, 3);
    fake.push(0.001, 8);
    await setImmediate();
    expect((await readGeneration(generations[0]!)).text).toBe(' Sure.');
  });

  it('carries fragments beyond a burst into the next burst', async () => {
    const { fake, generations } = setup();
    fake.push(0.001, 20);
    fake.push(0.3, 3);
    await setImmediate();
    fake.say(' Checking the current conditions.', 2000, 2800);
    fake.say(" It's", 4200, 4400);
    fake.push(0.001, 8);
    await setImmediate();
    expect((await readGeneration(generations[0]!)).text).toBe(' Checking the current conditions.');
    fake.push(0.3, 3);
    await setImmediate();
    fake.say(' 62 degrees.', 4400, 5000);
    fake.push(0.3, 3);
    fake.push(0.001, 8);
    await setImmediate();
    expect((await readGeneration(generations[1]!)).text).toBe(" It's 62 degrees.");
  });

  it('anchors late fragments at the onset and keeps annotations monotonic', async () => {
    const { fake, generations } = setup();
    fake.push(0.001, 20);
    fake.push(0.3, 5);
    await setImmediate();
    fake.say('Hello there.', 9000, 9400);
    fake.say(' Again.', 9200, 9300);
    fake.push(0.3);
    await fake.close();
    await setImmediate();
    expect((await readGeneration(generations[0]!)).chunks).toMatchObject([
      { startTime: 0, endTime: 0.4 },
      { startTime: 0.4, endTime: 0.4 },
    ]);
  });

  it('attaches an ahead-of-audio fragment only when the audio reaches it', async () => {
    const { fake, generations } = setup();
    fake.push(0.001, 20);
    fake.push(0.3, 3);
    await setImmediate();
    fake.say(" Yep, I've got order A1042", 5000, 5600);
    fake.say(' on file.', 6500, 6900);
    fake.push(0.3);
    await setImmediate();
    const messageReader = generations[0]!.messageStream.getReader();
    const message = (await messageReader.read()).value!;
    const reader = message.textStream.getReader();
    expect((await reader.read()).value).toMatchObject({ text: " Yep, I've got order A1042" });
    let nextArrived = false;
    const next = reader.read().then((value) => {
      nextArrived = true;
      return value;
    });
    await setImmediate();
    expect(nextArrived).toBe(false);
    fake.push(0.3, 2);
    fake.push(0.001, 4);
    fake.push(0.3, 3);
    await setImmediate();
    expect((await next).value).toMatchObject({ text: ' on file.' });
    fake.push(0.001, 8);
    await setImmediate();
    expect(generations).toHaveLength(1);
    reader.releaseLock();
    messageReader.releaseLock();
  });

  it('emits an unclaimed transcript after three seconds of silent audio', async () => {
    const { fake, generations } = setup();
    const error = vi.spyOn(log(), 'error');
    fake.push(0.001, 20);
    await setImmediate();
    fake.say('lost audio');
    fake.push(0.001, 29);
    await setImmediate();
    expect(generations).toHaveLength(0);
    fake.push(0.001);
    await setImmediate();
    const result = await readGeneration(generations[0]!);
    expect(result.text).toBe('lost audio');
    expect(result.frames).toHaveLength(0);
    expect(error).toHaveBeenCalledWith(
      expect.anything(),
      'duplex transcript outlived the audio it describes',
    );
  });
});

describe('duplex events and context', () => {
  it.each([false, true])(
    'delivers tool calls with or without speech (speaking: %s)',
    async (speaking) => {
      const { fake, session, generations } = setup();
      if (speaking) {
        fake.push(0.001, 20);
        fake.push(0.3, 3);
        await setImmediate();
      }
      const call = FunctionCall.create({ callId: 'c1', name: 'lookup', args: '{}' });
      fake.emit('function_call', call);
      if (speaking) {
        fake.say('Let me check.');
        fake.push(0.001, 8);
        await setImmediate();
      }
      expect(generations).toHaveLength(1);
      const result = await readGeneration(generations[0]!);
      expect(result.functions).toEqual([call]);
      expect(result.messages).toHaveLength(speaking ? 1 : 0);
      expect(result.text).toBe(speaking ? 'Let me check.' : '');
      expect(session.chatCtx.getById(call.id)).toBe(call);
    },
  );

  it('reconnects without carrying abandoned fragments into new speech', async () => {
    const { model, fake, session, generations } = setup();
    const reconnected = vi.fn();
    session.on('session_reconnected', reconnected);
    fake.push(0.001, 20);
    fake.push(0.3, 3);
    await setImmediate();
    fake.say('lost words');
    fake.emit('session_reconnected', {});
    expect((await readGeneration(generations[0]!)).text).toBe('');
    model.askable = true;
    const reply = session.generateReply();
    const replied = vi.fn();
    void reply.then(replied, replied);
    fake.push(0.001, 3);
    await setImmediate();
    expect(generations).toHaveLength(1);
    expect(replied).not.toHaveBeenCalled();
    fake.push(0.3, 3);
    fake.push(0.001, 8);
    await setImmediate();
    await expect(reply).resolves.toBe(generations[1]);
    expect((await readGeneration(generations[1]!)).text).toBe('');
    expect(reconnected).toHaveBeenCalledOnce();
  });

  it('forwards user events without cutting the current burst', async () => {
    const { fake, session, generations } = setup();
    const events: unknown[] = [];
    for (const name of [
      'input_speech_started',
      'input_audio_transcription_completed',
      'input_speech_stopped',
    ]) {
      session.on(name, (ev) => events.push(ev));
    }
    fake.push(0.001, 20);
    fake.push(0.3, 3);
    await setImmediate();
    fake.heard('u1', 'Hello');
    fake.say('Still speaking');
    fake.push(0.3, 2);
    fake.push(0.001, 8);
    await setImmediate();
    expect(generations).toHaveLength(1);
    expect(events).toHaveLength(3);
    expect((await readGeneration(generations[0]!)).text).toBe('Still speaking');
    expect(session.chatCtx.getById('u1')).toMatchObject({ transcriptConfidence: 1 });
  });

  it('records the same message IDs and preserves a delayed user transcript time and confidence', async () => {
    const { fake, session, generations } = setup();
    fake.push(0.001, 20);
    fake.push(0.3, 3);
    await setImmediate();
    fake.say('Hi');
    fake.push(0.001, 8);
    await setImmediate();
    fake.emit('input_audio_transcription_completed', {
      itemId: 'u1',
      transcript: 'Hello',
      isFinal: true,
      turnStartedAt: 1000,
      confidence: 0,
    });
    const items = session.chatCtx.items;
    expect(items[0]).toMatchObject({ id: 'u1', createdAt: 1000, transcriptConfidence: 0 });
    expect(items[1]).toMatchObject({
      id: generations[0]!.responseId,
      role: 'assistant',
      content: ['Hi'],
    });
    await session.updateChatCtx(session.chatCtx);
    expect(fake.appended).toEqual([]);
  });

  it('forwards only new chat items and warns for edits to append-only history', async () => {
    const { fake, session } = setup();
    fake.heard('u1', 'Hello');
    const context = session.chatCtx;
    context.addMessage({ id: 'typed', role: 'user', content: 'typed input' });
    const output = FunctionCallOutput.create({
      callId: 'c1',
      name: 'lookup',
      output: 'rainy',
      isError: false,
    });
    context.insert(output);
    await session.updateChatCtx(context);
    expect(fake.appended.map((item) => item.id)).toEqual(['typed', output.id]);
    const warn = vi.spyOn(log(), 'warn');
    const edited = session.chatCtx;
    edited.remove('u1');
    await session.updateChatCtx(edited);
    expect(warn).toHaveBeenCalledWith(
      { item_ids: ['u1'] },
      'duplex context is append-only; the model keeps what it has been told',
    );
    expect(fake.appended).toHaveLength(2);
  });

  it('allows the framework to shorten assistant transcripts without warning or resending them', async () => {
    const { fake, session } = setup();
    const context = ChatContext.empty();
    context.addMessage({ id: 'assistant', role: 'assistant', content: 'Hello there' });
    await session._updateSession(undefined, context);
    const edited = ChatContext.empty();
    edited.addMessage({ id: 'assistant', role: 'assistant', content: 'Hello' });
    const warn = vi.spyOn(log(), 'warn');
    await session.updateChatCtx(edited);
    expect(warn).not.toHaveBeenCalled();
    expect(fake.appended).toHaveLength(1);
  });

  it('hands over complete configuration and seeds both histories', async () => {
    const { fake, session } = setup();
    expect(fake.configured).toBe(false);
    const context = ChatContext.empty();
    context.addMessage({ id: 'm1', role: 'user', content: 'a prior turn' });
    const tools = ToolContext.empty();
    await session._updateSession('be brief', context, tools);
    expect(fake.configured).toBe(true);
    expect(fake.connected).toBe(true);
    expect(fake.configBatches).toEqual([['be brief', expect.any(ChatContext), tools]]);
    expect(fake.appended.map((item) => item.id)).toEqual(['m1']);
    expect(session.chatCtx.items.map((item) => item.id)).toEqual(['m1']);
  });

  it.each([
    new RealtimeError('configuration failed'),
    new Error('configuration failed'),
    new DOMException('configuration aborted', 'AbortError'),
  ])('closes a session whose startup configuration fails with %s', async (error) => {
    const { fake, session } = setup();
    vi.spyOn(fake, '_updateInstructions').mockRejectedValueOnce(error);
    const updateTools = vi.spyOn(fake, '_updateTools');
    const context = ChatContext.empty();
    context.addMessage({ id: 'm1', role: 'user', content: 'a prior turn' });

    await expect(session._updateSession('be brief', context, ToolContext.empty())).rejects.toBe(
      error,
    );

    expect(fake.appended).toEqual([]);
    expect(updateTools).not.toHaveBeenCalled();
    expect(fake.closed).toBe(true);
    expect(fake.connected).toBe(false);
    expect(fake.configured).toBe(true);
    expect(fake.audioStream.locked).toBe(false);
    expect(fake.eventNames()).toEqual([]);
  });

  it('forwards input, configuration, metrics, and provider errors', async () => {
    const { fake, adapter, session } = setup();
    const push = vi.spyOn(fake, 'pushAudio');
    const instructions = vi.spyOn(fake, '_updateInstructions');
    const tools = vi.spyOn(fake, '_updateTools');
    const options = vi.spyOn(fake, '_updateOptions');
    const metrics: RealtimeModelMetrics[] = [];
    const errors: RealtimeModelError[] = [];
    session.on('metrics_collected', (ev) => metrics.push(ev));
    session.on('error', (ev) => errors.push(ev));
    const input = frame(0.3);
    session.pushAudio(input);
    await session.updateInstructions('new instructions');
    const context = ToolContext.empty();
    await session.updateTools(context);
    session.updateOptions({ toolChoice: 'none' });
    fake.reportConnectionAcquired(125);
    const error: RealtimeModelError = {
      type: 'realtime_model_error',
      error: new Error('provider'),
      timestamp: Date.now(),
      label: 'fake',
      recoverable: true,
    };
    fake.emit('error', error);
    expect(push).toHaveBeenCalledWith(input);
    expect(instructions).toHaveBeenCalledWith('new instructions');
    expect(tools).toHaveBeenCalledWith(context);
    expect(session.tools).toBe(context);
    expect(options).toHaveBeenCalledWith({ toolChoice: 'none' });
    expect(errors).toEqual([error]);
    expect(metrics).toMatchObject([
      {
        acquireTimeMs: 125,
        connectionReused: false,
        inputTokens: 0,
        outputTokens: 0,
        metadata: { modelName: adapter.model, modelProvider: adapter.provider },
      },
    ]);
  });

  it('reports a failed audio consumer as unrecoverable and closes the open generation', async () => {
    const { fake, session, generations } = setup({ gate: () => new FixedGate(0.002) });
    const errors: RealtimeModelError[] = [];
    session.on('error', (error) => errors.push(error));
    fake.push(0.3);
    await setImmediate();
    fake.controller.error(new Error('stream failed'));
    fake.closed = true;
    await setImmediate();
    expect(errors).toMatchObject([
      { recoverable: false, label: fake.duplexModel.label(), error: new Error('stream failed') },
    ]);
    expect((await readGeneration(generations[0]!)).frames).toHaveLength(1);
  });

  it('releases the blocked reader and event listeners when closing before configuration', async () => {
    const { fake, session } = setup();
    const close = vi.spyOn(fake, 'close');
    const closing = Promise.all([session.close(), session.close()]);
    try {
      await vi.waitFor(() => expect(fake.closed).toBe(true));
      expect(close).toHaveBeenCalledOnce();
      expect(fake.configured).toBe(true);
      expect(fake.connected).toBe(false);
      expect(fake.audioStream.locked).toBe(false);
      expect(fake.eventNames()).toEqual([]);
    } finally {
      await fake._updateSession();
      await closing;
    }
  });
});

describe('duplex requested replies', () => {
  it('rejects requests if the model decides when to speak', async () => {
    const { session } = setup();
    await expect(session.generateReply()).rejects.toThrow('decides for itself');
  });

  it('resolves a requested reply on speech, not an earlier standalone tool call', async () => {
    const { fake, model, session, generations } = setup();
    model.askable = true;
    const reply = session.generateReply('say hi');
    let replied = false;
    void reply.then(() => {
      replied = true;
    });
    expect(fake.repliesRequested).toEqual(['say hi']);
    fake.emit('function_call', FunctionCall.create({ callId: 'c1', name: 'lookup', args: '{}' }));
    await setImmediate();
    expect(replied).toBe(false);
    expect(generations[0]!.userInitiated).toBe(false);
    fake.push(0.001, 20);
    fake.push(0.3, 3);
    await setImmediate();
    expect(await reply).toBe(generations[1]);
    expect(generations[1]!.userInitiated).toBe(true);
  });

  it('rejects superseded, reconnected, and closed requests', async () => {
    const { model, fake, session } = setup();
    model.askable = true;
    const first = expect(session.generateReply()).rejects.toThrow('superseded');
    const second = expect(session.generateReply()).rejects.toThrow('reconnected');
    await first;
    fake.emit('session_reconnected', {});
    await second;
    const third = expect(session.generateReply()).rejects.toThrow('closed');
    await session.close();
    await third;
    await expect(session.generateReply()).rejects.toThrow('closed');
  });

  it('times out a declined request', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const { model, session } = setup();
    model.askable = true;
    const reply = expect(session.generateReply()).rejects.toThrow('did not start speaking');
    await vi.advanceTimersByTimeAsync(10_000);
    await reply;
    expect(vi.getTimerCount()).toBe(0);
  });

  it('cancels pending requests with AbortSignal without claiming later spontaneous speech', async () => {
    const { model, fake, session, generations } = setup({ gate: () => new FixedGate(0.002) });
    model.askable = true;
    const controller = new AbortController();
    const reply = expect(
      session.generateReply(undefined, { signal: controller.signal }),
    ).rejects.toThrow('aborted');
    controller.abort();
    await reply;
    fake.push(0.3);
    await setImmediate();
    expect(generations[0]!.userInitiated).toBe(false);
    const count = fake.repliesRequested.length;
    await expect(session.generateReply(undefined, { signal: controller.signal })).rejects.toThrow(
      'aborted',
    );
    expect(fake.repliesRequested).toHaveLength(count);
  });
});

describe('duplex model integration', () => {
  it('closes the provider immediately when startup configuration fails', async () => {
    vi.spyOn(FakeDuplexSession.prototype, '_updateInstructions').mockRejectedValueOnce(
      new RealtimeError('configuration failed'),
    );
    const model = new FakeDuplexModel();
    const agent = new Agent({ instructions: 'be brief' });
    const session = new AgentSession({ llm: model, vad: null, aecWarmupDuration: null });
    const closeProvider = vi.spyOn(FakeDuplexSession.prototype, 'close');
    await session.start({ agent });
    const provider = model.activeSession;
    try {
      expect(provider.closed).toBe(true);
      expect(provider.configured).toBe(true);
      expect(provider.connected).toBe(false);
      expect(provider.audioStream.locked).toBe(false);
      expect(provider.eventNames()).toEqual([]);
    } finally {
      await session.close();
    }
    expect(closeProvider).toHaveBeenCalledOnce();
    expect(() => agent.getActivityOrThrow()).toThrow('Agent activity not found');
  });

  it.each(['none', 'listening', 'throwing'] as const)(
    'closes on an unrecoverable audio error with a %s application error listener',
    async (listener) => {
      const model = new FakeDuplexModel();
      const agent = new Agent({ instructions: '' });
      const session = new AgentSession({ llm: model, vad: null, aecWarmupDuration: null });
      const closed = vi.fn();
      session.on(AgentSessionEventTypes.Close, closed);
      const errors = vi.fn(() => {
        if (listener === 'throwing') throw new Error('application error listener failed');
      });
      if (listener !== 'none') session.on(AgentSessionEventTypes.Error, errors);
      await session.start({ agent });
      const provider = model.activeSession;
      const closeProvider = vi.spyOn(provider, 'close');
      provider.controller.error(new Error('audio stream failed'));
      provider.closed = true;

      try {
        await vi.waitFor(() => {
          expect(closed).toHaveBeenCalledWith(
            expect.objectContaining({ reason: CloseReason.ERROR }),
          );
        });
        expect(closeProvider).toHaveBeenCalledOnce();
        expect(provider.eventNames()).toEqual([]);
        expect(errors).toHaveBeenCalledTimes(listener === 'none' ? 0 : 1);
        expect(() => agent.getActivityOrThrow()).toThrow('Agent activity not found');
      } finally {
        await session.close();
      }
    },
  );

  it.each([false, true])(
    'closes after an audio error during shutdown (error listener: %s)',
    async (listenForErrors) => {
      const model = new FakeDuplexModel();
      const agent = new Agent({ instructions: '' });
      const session = new AgentSession({ llm: model, vad: null, aecWarmupDuration: null });
      const errors = vi.fn();
      if (listenForErrors) session.on(AgentSessionEventTypes.Error, errors);
      await session.start({ agent });
      const provider = model.activeSession;
      const realtime = agent.getActivityOrThrow().realtimeLLMSession!;
      const closeProvider = vi.spyOn(provider, 'close');
      const closeKeyterms = session._keytermDetector.aclose.bind(session._keytermDetector);
      vi.spyOn(session._keytermDetector, 'aclose').mockImplementationOnce(async () => {
        provider.controller.error(new Error('audio failed during shutdown'));
        provider.closed = true;
        await setImmediate();
        await closeKeyterms();
      });

      await session.close();

      expect(closeProvider).toHaveBeenCalledOnce();
      expect(provider.audioStream.locked).toBe(false);
      expect(provider.eventNames()).toEqual([]);
      expect(realtime.listenerCount('error')).toBe(0);
      expect(realtime.listenerCount('metrics_collected')).toBe(0);
      expect(errors).toHaveBeenCalledTimes(listenForErrors ? 1 : 0);
      expect(() => agent.getActivityOrThrow()).toThrow('Agent activity not found');
    },
  );

  it('wraps models passed to Agent, AgentSession, and updateOptions', async () => {
    const model = new FakeDuplexModel();
    const session = new AgentSession({ llm: model, vad: null });
    const agent = new Agent({ instructions: '', llm: model });
    expect(session.llm).toBeInstanceOf(DuplexRealtimeAdapter);
    expect(agent.llm).toBeInstanceOf(DuplexRealtimeAdapter);
    const replacement = new FakeDuplexModel();
    await agent.updateOptions({ llm: replacement });
    expect((agent.llm as DuplexRealtimeAdapter).duplexModel).toBe(replacement);
    expect(() => agent.duplexSession).toThrow('Agent activity not found');
  });

  it('exposes the running provider session and rejects a model swap while running', async () => {
    const model = new FakeDuplexModel();
    const agent = new Agent({ instructions: '' });
    const session = new AgentSession({ llm: model, vad: null, aecWarmupDuration: null });
    await session.start({ agent });
    try {
      expect(agent.duplexSession).toBe(model.activeSession);
      expect(model.activeSession.configured).toBe(true);
      await expect(agent.updateOptions({ llm: new FakeDuplexModel() })).rejects.toThrow();
    } finally {
      await session.close();
    }
  });

  it('rejects duplexSession when the running agent has no duplex model', async () => {
    const agent = new Agent({ instructions: '' });
    const session = new AgentSession({ vad: null, turnHandling: { turnDetection: null } });
    await session.start({ agent });
    try {
      expect(() => agent.duplexSession).toThrow('not running a DuplexModel');
    } finally {
      await session.close();
    }
  });
});
