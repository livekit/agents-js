// SPDX-FileCopyrightText: 2026 LiveKit, Inc.
//
// SPDX-License-Identifier: Apache-2.0

/** Ported from Python `tests/test_amd_realtime.py`. */
import { AudioFrame } from '@livekit/rtc-node';
import { ReadableStream, type ReadableStreamDefaultController } from 'node:stream/web';
import { describe, expect, it, onTestFinished, vi } from 'vitest';
import { asLanguageCode } from '../../language.js';
import { ChatContext, ChatMessage, FunctionCall } from '../../llm/chat_context.js';
import {
  type GenerationCreatedEvent,
  type InputTranscriptionCompleted,
  type MessageGeneration,
  type RealtimeCapabilities,
  RealtimeModel,
  RealtimeSession,
} from '../../llm/realtime.js';
import { type ToolChoice, ToolContext, handoff, tool } from '../../llm/tool_context.js';
import type { STT } from '../../stt/stt.js';
import { type SpeechEvent, SpeechEventType } from '../../stt/stt.js';
import { FakeSTT } from '../../stt/testing/fake_stt.js';
import { Future, delay, shortuuid } from '../../utils.js';
import { VAD, type VADEvent, VADEventType, type VADStream } from '../../vad.js';
import { Agent } from '../agent.js';
import { AgentSession } from '../agent_session.js';
import { AgentSessionEventTypes } from '../events.js';
import { AudioInput, AudioOutput } from '../io.js';
import type { SpeechHandle } from '../speech_handle.js';
import {
  ClassifierLLM,
  CustomerAgent,
  DrainingSTT,
  endOfTurn,
  eventually,
  internals,
  speechEnded,
  speechStarted,
  waitFor,
} from './amd_test_utils.js';
import {
  AMD,
  DEFAULT_HUMAN_INSTRUCTIONS,
  DEFAULT_IVR_INSTRUCTIONS,
  DEFAULT_SCREENING_INSTRUCTIONS,
  DEFAULT_VOICEMAIL_INSTRUCTIONS,
} from './detector.js';
import { AMDCategory, AMDLifecycle } from './events.js';

const jobContext = vi.hoisted(() => ({ current: undefined as unknown }));

// `sendDtmfEvents` reads the job room when the session has no room IO; Python patches it
vi.mock('../../job.js', async (importOriginal) => {
  const actual = await importOriginal<{ getJobContext: (required?: boolean) => unknown }>();
  return {
    ...actual,
    getJobContext: vi.fn((required = true) =>
      jobContext.current !== undefined ? jobContext.current : actual.getJobContext(required),
    ),
  };
});

const SAMPLE_RATE = 24_000;

function audioFrame(duration: number): AudioFrame {
  const samples = Math.floor((SAMPLE_RATE * duration) / 1000);
  return new AudioFrame(new Int16Array(samples).fill(1), SAMPLE_RATE, 1, samples);
}

function stream<T>(...items: T[]): ReadableStream<T> {
  return new ReadableStream<T>({
    start(controller) {
      for (const item of items) controller.enqueue(item);
      controller.close();
    },
  });
}

/** Everything enabled, overriding individual flags. Mirrors Python `fake_capabilities`. */
function fakeCapabilities(overrides: Partial<RealtimeCapabilities> = {}): RealtimeCapabilities {
  return {
    messageTruncation: true,
    turnDetection: true,
    userTranscription: true,
    autoToolReplyGeneration: true,
    audioOutput: true,
    manualFunctionCalls: true,
    midSessionChatCtxUpdate: true,
    midSessionInstructionsUpdate: true,
    midSessionToolsUpdate: true,
    perResponseToolChoice: true,
    // a different interruption model rather than a richer one, so it stays off
    supportsOverlappingSpeech: false,
    ...overrides,
  };
}

/** A hermetic RealtimeSession that records calls. Mirrors Python `FakeRealtimeSession`. */
class FakeRealtimeSession extends RealtimeSession {
  private _chatCtx = ChatContext.empty();
  private _tools = ToolContext.empty();
  committed = false;
  commitAudioCalls = 0;
  audioCleared = false;
  interrupted = false;
  readonly pushedAudio: AudioFrame[] = [];
  generateReplyCalls = 0;
  readonly replyInstructions: (string | undefined)[] = [];
  /** Per-response tools, as Python's `reply_tools`; `undefined` when none were passed. */
  readonly replyTools: (ToolContext | undefined)[] = [];
  updatedInstructions: string | undefined;
  toolChoice: ToolChoice | null | undefined;
  readonly replyFuts: Future<GenerationCreatedEvent>[] = [];

  get chatCtx(): ChatContext {
    return this._chatCtx;
  }

  get tools(): ToolContext {
    return this._tools;
  }

  async updateInstructions(instructions: string): Promise<void> {
    this.updatedInstructions = instructions;
  }

  async updateChatCtx(chatCtx: ChatContext): Promise<void> {
    // a remote session keeps its own copy; Agent.chatCtx shares the agent's item list
    this._chatCtx = chatCtx.copy();
  }

  async updateTools(tools: ToolContext): Promise<void> {
    this._tools = tools;
  }

  updateOptions(options: { toolChoice?: ToolChoice | null }): void {
    this.toolChoice = options.toolChoice;
  }

  pushAudio(frame: AudioFrame): void {
    this.pushedAudio.push(frame);
  }

  async generateReply(
    instructions?: string,
    options: { toolChoice?: ToolChoice; tools?: ToolContext } = {},
  ): Promise<GenerationCreatedEvent> {
    this.generateReplyCalls += 1;
    this.replyInstructions.push(instructions);
    this.replyTools.push(options.tools);
    const fut = new Future<GenerationCreatedEvent>();
    this.replyFuts.push(fut);
    return fut.await;
  }

  async commitAudio(): Promise<void> {
    this.committed = true;
    this.commitAudioCalls += 1;
  }

  async clearAudio(): Promise<void> {
    this.audioCleared = true;
  }

  async interrupt(): Promise<void> {
    this.interrupted = true;
  }

  async truncate(): Promise<void> {}
}

/** A RealtimeModel whose sessions are FakeRealtimeSession. */
class FakeRealtimeModel extends RealtimeModel {
  readonly createdSessions: FakeRealtimeSession[] = [];

  get model(): string {
    return 'fake-realtime';
  }

  get activeSession(): FakeRealtimeSession {
    return this.createdSessions[this.createdSessions.length - 1]!;
  }

  session(): RealtimeSession {
    const session = new FakeRealtimeSession(this);
    this.createdSessions.push(session);
    return session;
  }

  async close(): Promise<void> {}
}

/** Plays captured audio on a pausable playout clock. Mirrors Python `FakeAudioOutput`. */
class FakeAudioOutput extends AudioOutput {
  pushedDuration = 0;
  pausedAt: number | undefined;
  private flushed = false;
  private timer: ReturnType<typeof setTimeout> | undefined;
  private startedAt: number | undefined;
  private totalPaused = 0;

  constructor({ canPause = false }: { canPause?: boolean } = {}) {
    super(SAMPLE_RATE, undefined, { pause: canPause });
  }

  private playedDuration(): number {
    if (this.startedAt === undefined) return 0;
    const end = this.pausedAt ?? Date.now();
    return end - this.startedAt - this.totalPaused;
  }

  private resetPlayout(): void {
    this.pushedDuration = 0;
    this.flushed = false;
    this.startedAt = undefined;
    this.pausedAt = undefined;
    this.totalPaused = 0;
    clearTimeout(this.timer);
    this.timer = undefined;
  }

  private scheduleFlushCompletion(): void {
    clearTimeout(this.timer);
    this.timer = undefined;
    if (this.pausedAt !== undefined) return; // defer until resume()
    const pushed = this.pushedDuration;
    this.timer = setTimeout(
      () => {
        this.resetPlayout();
        this.onPlaybackFinished({ playbackPosition: pushed / 1000, interrupted: false });
      },
      Math.max(pushed - this.playedDuration(), 0),
    );
  }

  override async captureFrame(frame: AudioFrame): Promise<void> {
    await super.captureFrame(frame);
    this.pushedDuration += (frame.samplesPerChannel / frame.sampleRate) * 1000;
    if (this.pausedAt !== undefined) return;
    if (this.startedAt === undefined) {
      this.startedAt = Date.now();
      this.onPlaybackStarted(this.startedAt);
    }
  }

  override pause(): void {
    super.pause();
    if (this.pausedAt === undefined) this.pausedAt = Date.now();
    clearTimeout(this.timer);
    this.timer = undefined;
  }

  override resume(): void {
    super.resume();
    if (this.pausedAt !== undefined) {
      this.totalPaused += Date.now() - this.pausedAt;
      this.pausedAt = undefined;
    }
    if (this.startedAt === undefined && this.pushedDuration > 0) {
      this.startedAt = Date.now();
      this.onPlaybackStarted(this.startedAt);
    }
    if (this.flushed) this.scheduleFlushCompletion();
  }

  override flush(): void {
    super.flush();
    if (!this.pushedDuration) return;
    this.flushed = true;
    this.scheduleFlushCompletion();
  }

  clearBuffer(): void {
    if (!this.pushedDuration) return;
    const position = Math.min(this.playedDuration(), this.pushedDuration);
    this.resetPlayout();
    this.onPlaybackFinished({ playbackPosition: position / 1000, interrupted: true });
  }
}

/** An audio input the test pushes frames into, like Python `activity.push_audio`. */
class PushAudioInput extends AudioInput {
  #controller!: ReadableStreamDefaultController<AudioFrame>;

  constructor() {
    super();
    this.multiStream.addInputStream(
      new ReadableStream<AudioFrame>({
        start: (controller) => {
          this.#controller = controller;
        },
      }),
    );
  }

  push(frame: AudioFrame): void {
    this.#controller.enqueue(frame);
  }
}

/** A VAD whose stream yields only the events a test pushes. */
class ScriptedVAD extends VAD {
  label = 'scripted-vad';
  private readonly buffered: VADEvent[] = [];
  private resolveNext: ((result: IteratorResult<VADEvent>) => void) | undefined;
  private closed = false;

  constructor() {
    super({ updateInterval: 32 });
  }

  stream(): VADStream {
    const close = () => {
      this.closed = true;
      this.resolveNext?.({ done: true, value: undefined });
      this.resolveNext = undefined;
    };
    return {
      updateInputStream() {},
      detachInputStream() {},
      flush() {},
      close,
      [Symbol.asyncIterator]: () => ({
        next: (): Promise<IteratorResult<VADEvent>> => {
          if (this.buffered.length > 0) {
            return Promise.resolve({ done: false, value: this.buffered.shift()! });
          }
          if (this.closed) return Promise.resolve({ done: true, value: undefined });
          return new Promise((resolve) => {
            this.resolveNext = resolve;
          });
        },
      }),
    } as unknown as VADStream;
  }

  /** Deliver one event and let the recognition loop process it. */
  async emitEvent(event: VADEvent): Promise<void> {
    if (this.resolveNext) {
      const resolve = this.resolveNext;
      this.resolveNext = undefined;
      resolve({ done: false, value: event });
    } else {
      this.buffered.push(event);
    }
    await flush();
  }
}

async function flush(): Promise<void> {
  for (let i = 0; i < 3; i++) {
    await new Promise((resolve) => setImmediate(resolve));
  }
}

function vadEvent(
  type: VADEventType,
  { speechDuration = 0, silenceDuration = 0, timestamp = 0 } = {},
): VADEvent {
  return {
    type,
    samplesIndex: 0,
    timestamp,
    speechDuration,
    silenceDuration,
    frames: [],
    probability: 0,
    inferenceDuration: 0,
    speaking: type === VADEventType.START_OF_SPEECH,
    rawAccumulatedSilence: 0,
    rawAccumulatedSpeech: 0,
  };
}

function sttFinal(text: string): SpeechEvent {
  return {
    type: SpeechEventType.FINAL_TRANSCRIPT,
    alternatives: [
      { text, language: asLanguageCode('en'), startTime: 0, endTime: 0, confidence: 1 },
    ],
  };
}

type ActivityInternals = {
  _authorizationPaused: boolean;
  _userTurnCompletedTask?: { result: Promise<void> };
  audioRecognition: { onSTTEvent(event: SpeechEvent): Promise<void> };
  onStartOfSpeech(event: VADEvent): void;
  onEndOfSpeech(event: VADEvent | undefined, speechEndTime: number): void;
  interruptByAudioActivity(): void;
  onEndOfTurn(info: ReturnType<typeof endOfTurn>): Promise<boolean>;
};

function activityOf(session: AgentSession): ActivityInternals {
  return session._activity as unknown as ActivityInternals;
}

async function userTurnCompleted(session: AgentSession): Promise<void> {
  await waitFor(activityOf(session)._userTurnCompletedTask!.result);
}

function amdCurrent(detector: AMD, source: 'session' | 'amd'): string {
  const stt = internals(detector).run!.stt as unknown as {
    current: { get(source: 'session' | 'amd'): string };
  };
  return stt.current.get(source);
}

function userMessages(chatCtx: ChatContext): ChatMessage[] {
  return chatCtx.items.filter(
    (item): item is ChatMessage => item instanceof ChatMessage && item.role === 'user',
  );
}

function messages(chatCtx: ChatContext): ChatMessage[] {
  return chatCtx.items.filter((item): item is ChatMessage => item instanceof ChatMessage);
}

interface RealtimeRunning {
  detector: AMD;
  session: AgentSession;
  classifier: ClassifierLLM;
  rt: FakeRealtimeSession;
  audioInput: PushAudioInput;
  vad: ScriptedVAD | undefined;
}

async function running({
  machineSilenceThreshold = 0,
  agent,
  sessionStt = true,
  amdStt,
  userTranscription = true,
  turnDetection = 'manual',
}: {
  machineSilenceThreshold?: number;
  agent?: Agent;
  sessionStt?: boolean;
  amdStt?: STT;
  userTranscription?: boolean;
  turnDetection?: 'manual' | 'vad';
} = {}): Promise<RealtimeRunning> {
  const model = new FakeRealtimeModel(
    fakeCapabilities({
      canDisableTurnDetection: true,
      autoToolReplyGeneration: false,
      userTranscription,
    }),
  );
  const vad = turnDetection === 'vad' ? new ScriptedVAD() : undefined;
  const session = new AgentSession({
    llm: model,
    stt: sessionStt ? new FakeSTT() : undefined,
    vad: vad ?? null,
    turnHandling: { turnDetection, interruption: { mode: 'vad' } },
    aecWarmupDuration: null,
  });
  const audioInput = new PushAudioInput();
  session.input.audio = audioInput;
  session.output.audio = new FakeAudioOutput();
  await session.start({
    agent: agent ?? new Agent({ instructions: 'Call about an appointment.' }),
  });
  const classifier = new ClassifierLLM();
  const detector = new AMD(session, {
    llm: classifier,
    stt: amdStt ?? null,
    machineSilenceThreshold,
  });
  onTestFinished(async () => {
    await detector.aclose();
    await session.close();
  });
  await detector.start();
  await eventually(() => detector.lifecycle === AMDLifecycle.ACTIVE);
  return { detector, session, classifier, rt: model.activeSession, audioInput, vad };
}

/**
 * Commit a turn, release its prediction, and return the reply handle once it generates.
 * Wrapped in an object: a SpeechHandle is a thenable, so resolving a promise with it would
 * wait for the speech to finish.
 */
async function reply(
  session: AgentSession,
  classifier: ClassifierLLM,
  rt: FakeRealtimeSession,
  category: AMDCategory,
): Promise<{ handle: SpeechHandle }> {
  const created = new Promise<{ handle: SpeechHandle }>((resolve) =>
    session.once(AgentSessionEventTypes.SpeechCreated, (ev) =>
      resolve({ handle: ev.speechHandle }),
    ),
  );
  const count = rt.generateReplyCalls;
  expect(await activityOf(session).onEndOfTurn(endOfTurn())).toBe(true);
  const request = await classifier.request();
  classifier.prediction(request.currentTurn.extra.turn_id as number, category);
  await eventually(() => rt.generateReplyCalls === count + 1);
  return created;
}

function respond(
  rt: FakeRealtimeSession,
  { toolCall, duration = 10 }: { toolCall?: FunctionCall; duration?: number } = {},
): void {
  const messageStream =
    toolCall !== undefined
      ? stream<MessageGeneration>()
      : stream<MessageGeneration>({
          messageId: shortuuid('message_'),
          textStream: stream('Please call me back.'),
          audioStream: stream(audioFrame(duration)),
          modalities: Promise.resolve(['audio', 'text']),
        });
  rt.replyFuts[rt.replyFuts.length - 1]!.resolve({
    messageStream,
    functionStream: toolCall !== undefined ? stream(toolCall) : stream<FunctionCall>(),
    userInitiated: true,
  });
}

async function done(handle: SpeechHandle, timeoutMs = 2_000): Promise<void> {
  await waitFor(handle.waitForPlayout(), timeoutMs);
}

describe('AMD with realtime models', () => {
  it.each([
    ['server_turn_detection', 'client-side turn detection'],
    ['auto_tool_reply', 'client-controlled tool replies'],
    ['session_tools_only', 'per-response tools'],
    ['missing_stt', 'session STT'],
    ['missing_classifier', 'LLM for classification'],
  ])('unsupported configuration does not install AMD (%s)', async (configuration, error) => {
    const model = new FakeRealtimeModel(
      fakeCapabilities({
        canDisableTurnDetection: configuration !== 'server_turn_detection',
        autoToolReplyGeneration: configuration === 'auto_tool_reply',
        perResponseToolChoice: configuration !== 'session_tools_only',
      }),
    );
    const session = new AgentSession({
      llm: model,
      stt: configuration === 'missing_stt' ? undefined : new FakeSTT(),
      vad: null,
      turnHandling: { turnDetection: 'manual' },
    });
    onTestFinished(() => session.close());
    await session.start({ agent: new Agent({ instructions: 'Call about an appointment.' }) });
    const detector = new AMD(session, {
      llm: configuration === 'missing_classifier' ? null : new ClassifierLLM(),
      stt: null,
    });
    await expect(detector.start()).rejects.toThrow(error);
    expect(session.amd).toBeNull();
    expect(session._turnHooks).toBeUndefined();
    expect(activityOf(session)._authorizationPaused).toBe(false);
    expect(detector.lifecycle).toBe(AMDLifecycle.INITIALIZED);
  });

  it('reply waits for classification and silence', async () => {
    vi.useFakeTimers({
      toFake: ['setTimeout', 'clearTimeout', 'performance', 'Date'],
      shouldAdvanceTime: true,
    });
    onTestFinished(() => {
      vi.useRealTimers();
    });
    const { detector, session, classifier, rt } = await running({
      machineSilenceThreshold: 1_500,
    });
    const handles: SpeechHandle[] = [];
    session.on(AgentSessionEventTypes.SpeechCreated, (ev) => handles.push(ev.speechHandle));
    speechStarted(detector);
    speechEnded(detector, 500);
    expect(await activityOf(session).onEndOfTurn(endOfTurn())).toBe(true);
    await classifier.request();
    await vi.advanceTimersByTimeAsync(100);
    expect(rt.generateReplyCalls).toBe(0);
    classifier.prediction(1, AMDCategory.MACHINE_SCREENING);
    await vi.advanceTimersByTimeAsync(500);
    expect(rt.generateReplyCalls).toBe(0);
    await eventually(() => rt.generateReplyCalls === 1);
    expect(rt.committed).toBe(true);
    expect(rt.replyInstructions).toEqual([DEFAULT_SCREENING_INSTRUCTIONS]);
    respond(rt);
    await done(handles[0]!);
  });

  it('untranscribed speech does not revoke reply authorization', async () => {
    const { detector, session, classifier, rt, vad } = await running({
      machineSilenceThreshold: 500,
      turnDetection: 'vad',
    });
    const { handle } = await reply(session, classifier, rt, AMDCategory.MACHINE_SCREENING);
    const activity = activityOf(session);
    const output = session.output.audio!;
    await vad!.emitEvent(vadEvent(VADEventType.START_OF_SPEECH));
    respond(rt);
    await delay(100);
    expect(handle.done()).toBe(false);
    expect(output.capturedPlayoutSegments).toBe(0);

    await vad!.emitEvent(vadEvent(VADEventType.END_OF_SPEECH, { speechDuration: 100 }));
    await done(handle, 200);
    expect(handle.interrupted).toBe(false);
    expect(output.capturedPlayoutSegments).toBe(1);
    expect(detector.lifecycle).toBe(AMDLifecycle.ACTIVE);
    expect(internals(detector)._turnId).toBe(1);
    expect(classifier.requests.empty).toBe(true);

    expect(await activity.onEndOfTurn(endOfTurn('Please hold.'))).toBe(true);
    await classifier.request();
    expect(activity._authorizationPaused).toBe(true);
    expect(rt.generateReplyCalls).toBe(1);
    classifier.prediction(2, AMDCategory.WAIT);
    await userTurnCompleted(session);
    expect(rt.generateReplyCalls).toBe(1);
    expect(output.capturedPlayoutSegments).toBe(1);
  });

  it('AMD interrupts a pending reply despite disabled interruptions', async () => {
    const agent = new Agent({
      instructions: 'Call about an appointment.',
      turnHandling: { interruption: { enabled: false } },
    });
    const { session, classifier, rt } = await running({ agent });
    const { handle } = await reply(session, classifier, rt, AMDCategory.MACHINE_SCREENING);
    const activity = activityOf(session);
    expect(await activity.onEndOfTurn(endOfTurn('Please hold.'))).toBe(true);
    await classifier.request();
    classifier.prediction(2, AMDCategory.WAIT);
    await userTurnCompleted(session);
    await done(handle, 100);
    expect(handle.interrupted).toBe(true);
    expect(rt.generateReplyCalls).toBe(1);
    expect(session.output.audio!.capturedPlayoutSegments).toBe(0);
  });

  it('AMD preserves false interruption resume', async () => {
    const agent = new Agent({
      instructions: 'Call about an appointment.',
      turnHandling: { interruption: { enabled: false } },
    });
    const { detector, session, classifier, rt } = await running({ agent, turnDetection: 'vad' });
    const output = new FakeAudioOutput({ canPause: true });
    session.output.audio = output;
    session.sessionOptions.turnHandling.interruption.minWords = 0;
    session.sessionOptions.turnHandling.interruption.falseInterruptionTimeout = 100;
    const resumed: boolean[] = [];
    session.on(AgentSessionEventTypes.AgentFalseInterruption, (event) =>
      resumed.push(event.resumed),
    );
    const { handle } = await reply(session, classifier, rt, AMDCategory.MACHINE_SCREENING);
    const activity = activityOf(session);
    respond(rt, { duration: 1_000 });
    await eventually(() => session.agentState === 'speaking');
    activity.onStartOfSpeech(vadEvent(VADEventType.START_OF_SPEECH));
    activity.interruptByAudioActivity();
    expect(output.pausedAt).toBeDefined();
    expect(handle.allowInterruptions).toBe(true);
    activity.onEndOfSpeech(undefined, Date.now());
    await done(handle);
    expect(resumed).toEqual([true]);
    expect(handle.interrupted).toBe(false);
    expect(output.capturedPlayoutSegments).toBe(1);
    expect(internals(detector)._turnId).toBe(1);
  });

  it('stage instructions expire after first human reply', async () => {
    const { session, classifier, rt } = await running();
    for (const [category, instructions] of [
      [AMDCategory.MACHINE_SCREENING, DEFAULT_SCREENING_INSTRUCTIONS],
      [AMDCategory.HUMAN, DEFAULT_HUMAN_INSTRUCTIONS],
    ] as const) {
      const { handle } = await reply(session, classifier, rt, category);
      expect(rt.replyInstructions[rt.replyInstructions.length - 1]).toBe(instructions);
      respond(rt);
      await done(handle);
    }

    expect(session.amd).toBeNull();
    expect(session._turnHooks).toBeUndefined();
    const handle = session.generateReply();
    await eventually(() => rt.generateReplyCalls === 3);
    expect(rt.replyInstructions[rt.replyInstructions.length - 1]).toBeUndefined();
    respond(rt);
    await done(handle);
    expect(rt.updatedInstructions).toBe('Call about an appointment.');
    for (const context of [session.history, session.currentAgent.chatCtx, rt.chatCtx]) {
      expect(messages(context).some((m) => (m.textContent ?? '').includes('Call state:'))).toBe(
        false,
      );
    }
  });

  describe.each([AMDCategory.WAIT, AMDCategory.MACHINE_UNAVAILABLE])('category %s', (category) => {
    it.each([false, true])(
      'suppressed reply keeps only the realtime transcript (transcription before verdict: %s)',
      async (transcriptionBeforeVerdict) => {
        const { session, classifier, rt } = await running();
        expect(await activityOf(session).onEndOfTurn(endOfTurn())).toBe(true);
        await classifier.request();
        const transcript: InputTranscriptionCompleted = {
          itemId: 'user-audio',
          transcript: 'hello',
          isFinal: true,
        };
        if (transcriptionBeforeVerdict) {
          rt.emit('input_audio_transcription_completed', transcript);
        }
        classifier.prediction(1, category);
        await userTurnCompleted(session);
        expect(rt.committed).toBe(true);
        expect(rt.generateReplyCalls).toBe(0);
        if (!transcriptionBeforeVerdict) {
          rt.emit('input_audio_transcription_completed', transcript);
        }
        for (const context of [session.currentAgent.chatCtx, session.history]) {
          expect(userMessages(context).map((m) => [m.id, m.textContent])).toEqual([
            ['user-audio', 'hello'],
          ]);
        }
      },
    );
  });

  describe.each([AMDCategory.WAIT, AMDCategory.MACHINE_UNAVAILABLE, AMDCategory.HUMAN])(
    'category %s',
    (category) => {
      it.each(['session', 'amd', 'both'] as const)(
        'external STT preserves history without native transcription (source: %s)',
        async (source) => {
          const amdStt = source !== 'session' ? new DrainingSTT() : undefined;
          const { detector, session, classifier, rt, audioInput } = await running({
            sessionStt: source !== 'amd',
            amdStt,
            userTranscription: false,
          });
          const handles: SpeechHandle[] = [];
          const added: ChatMessage[] = [];
          session.on(AgentSessionEventTypes.SpeechCreated, (ev) => handles.push(ev.speechHandle));
          session.on(AgentSessionEventTypes.ConversationItemAdded, (ev) => {
            if (ev.item instanceof ChatMessage) added.push(ev.item);
          });
          const activity = activityOf(session);
          audioInput.push(audioFrame(100));
          await eventually(() => rt.pushedAudio.length > 0);
          if (amdStt !== undefined) {
            await eventually(() => amdStt.streams.length > 0);
          }
          if (source !== 'amd') {
            await activity.audioRecognition.onSTTEvent(sttFinal('Session transcript.'));
          }
          if (amdStt !== undefined && source === 'amd') {
            amdStt.streams[0]!.sendFinal('AMD transcript.');
            await eventually(() => amdCurrent(detector, 'amd') === 'AMD transcript.');
          }

          session.commitUserTurn();
          const request = await classifier.request();
          expect(request.currentTurn.textContent).toBe(
            {
              amd: 'AMD transcript.',
              session: 'Session transcript.',
              both: '{"transcript_1": "Session transcript.", "transcript_2": ""}',
            }[source],
          );
          if (source === 'both') {
            // no race to lose: AMD's stream keeps listening alongside the session's
            expect(internals(detector).run!.stt.amdSttActive).toBe(true);
          }
          expect(rt.generateReplyCalls).toBe(0);
          classifier.prediction(1, category);
          await userTurnCompleted(session);
          if (category === AMDCategory.HUMAN) {
            await eventually(() => rt.generateReplyCalls === 1);
            respond(rt);
            await done(handles[0]!);
          } else {
            expect(rt.generateReplyCalls).toBe(0);
          }

          const expected = source === 'amd' ? 'AMD transcript.' : 'Session transcript.';
          for (const context of [session.currentAgent.chatCtx, session.history]) {
            expect(userMessages(context).map((m) => m.textContent)).toEqual([expected]);
          }
          expect(added.filter((m) => m.role === 'user').map((m) => m.textContent)).toEqual([
            expected,
          ]);
          expect(userMessages(rt.chatCtx)).toEqual([]);
          expect(rt.committed).toBe(true);
        },
      );
    },
  );

  it.each([AMDCategory.WAIT, AMDCategory.HUMAN])(
    'session STT classifies before realtime transcription (%s)',
    async (category) => {
      const { session, classifier, rt } = await running();
      const handles: SpeechHandle[] = [];
      session.on(AgentSessionEventTypes.SpeechCreated, (ev) => handles.push(ev.speechHandle));
      await activityOf(session).audioRecognition.onSTTEvent(sttFinal('Please hold.'));
      // JS commitUserTurn() returns nothing; the request carries the committed transcript
      session.commitUserTurn();
      const request = await classifier.request();
      expect(request.currentTurn.textContent).toBe('Please hold.');
      expect(messages(session.currentAgent.chatCtx)).toEqual([]);
      expect(handles).toEqual([]);
      classifier.prediction(1, category);
      await userTurnCompleted(session);
      if (category === AMDCategory.HUMAN) {
        await eventually(() => rt.generateReplyCalls === 1);
        expect(rt.replyInstructions[rt.replyInstructions.length - 1]).toBeUndefined();
        respond(rt);
        await done(handles[0]!);
      } else {
        expect(rt.generateReplyCalls).toBe(0);
      }
    },
  );

  describe.each([false, true])('session STT %s', (sessionStt) => {
    it('manual realtime commit without AMD (skip reply: false)', async () => {
      const model = new FakeRealtimeModel(fakeCapabilities({ canDisableTurnDetection: true }));
      const session = new AgentSession({
        llm: model,
        stt: sessionStt ? new FakeSTT() : undefined,
        vad: null,
        turnHandling: { turnDetection: 'manual' },
      });
      onTestFinished(() => session.close());
      const audioInput = new PushAudioInput();
      session.input.audio = audioInput;
      session.output.audio = new FakeAudioOutput();
      await session.start({ agent: new Agent({ instructions: 'Call about an appointment.' }) });
      const rt = model.activeSession;
      const handles: SpeechHandle[] = [];
      session.on(AgentSessionEventTypes.SpeechCreated, (ev) => handles.push(ev.speechHandle));
      audioInput.push(audioFrame(100));
      await eventually(() => rt.pushedAudio.length > 0);
      if (sessionStt) {
        await activityOf(session).audioRecognition.onSTTEvent(sttFinal('Hello.'));
      }

      session.commitUserTurn();
      await eventually(() => rt.generateReplyCalls === 1);
      expect(rt.commitAudioCalls).toBe(1);
      respond(rt);
      await done(handles[0]!);
      expect(rt.generateReplyCalls).toBe(1);
      expect(rt.commitAudioCalls).toBe(1);
      await session.close();
      if (!sessionStt) {
        expect(userMessages(session.history)).toEqual([]);
      }
    });

    it.skip('manual realtime commit without AMD (skip reply: true) (JS commitUserTurn has no skipReply option)', () => {});
  });

  describe.each([false, true])('session STT %s', (sessionStt) => {
    it.each(['manual', 'vad'] as const)(
      'AMD STT supplies transcripts at EOT (turn detection: %s)',
      async (turnDetection) => {
        const amdStt = new DrainingSTT();
        const { detector, session, classifier, rt, audioInput, vad } = await running({
          sessionStt,
          amdStt,
          turnDetection,
        });
        const handles: SpeechHandle[] = [];
        session.on(AgentSessionEventTypes.SpeechCreated, (ev) => handles.push(ev.speechHandle));
        const recognition = activityOf(session).audioRecognition;
        audioInput.push(audioFrame(100));
        await eventually(() => amdStt.streams.length > 0);
        const amdStream = amdStt.streams[0]!;
        if (!sessionStt) {
          rt.emit('input_audio_transcription_completed', {
            itemId: 'previous-audio',
            transcript: 'Late realtime transcript.',
            isFinal: true,
          } satisfies InputTranscriptionCompleted);
        }
        expect(internals(detector).run!.stt.amdSttActive).toBe(true);

        if (turnDetection === 'vad') {
          await vad!.emitEvent(vadEvent(VADEventType.START_OF_SPEECH));
        }
        if (sessionStt) {
          await recognition.onSTTEvent(sttFinal('Session transcript.'));
        }
        amdStream.sendFinal('Please state your name.');
        await eventually(() => amdCurrent(detector, 'amd') === 'Please state your name.');
        expect(rt.generateReplyCalls).toBe(0);
        expect(classifier.requests.empty).toBe(true);

        if (turnDetection === 'manual') {
          // JS commitUserTurn() returns nothing; the request below carries the transcript
          session.commitUserTurn();
        } else {
          await vad!.emitEvent(
            vadEvent(VADEventType.END_OF_SPEECH, {
              timestamp: 500,
              speechDuration: 500,
              silenceDuration: 500,
            }),
          );
        }
        const request = await classifier.request();
        expect(request.currentTurn.textContent).toBe(
          sessionStt
            ? '{"transcript_1": "Session transcript.", "transcript_2": "Please state your name."}'
            : 'Please state your name.',
        );
        expect(rt.generateReplyCalls).toBe(0);
        classifier.prediction(1, AMDCategory.MACHINE_SCREENING);
        await eventually(() => rt.generateReplyCalls === 1);
        expect(rt.replyInstructions[rt.replyInstructions.length - 1]).toBe(
          DEFAULT_SCREENING_INSTRUCTIONS,
        );
        expect(rt.pushedAudio.length).toBeGreaterThan(0);
        expect(rt.committed).toBe(true);
        respond(rt);
        await done(handles[0]!);
      },
    );
  });

  it('realtime tool handoff is cancelled while AMD is running', async () => {
    const replacement = new Agent({ instructions: 'Continue the call.' });
    const original = new Agent({
      instructions: 'Call about an appointment.',
      tools: {
        transfer: tool({
          description: 'Transfer the call to the next agent.',
          execute: async () => handoff({ agent: replacement }),
        }),
      },
    });
    const { detector, session, classifier, rt } = await running({ agent: original });
    const { handle } = await reply(session, classifier, rt, AMDCategory.MACHINE_SCREENING);
    respond(rt, {
      toolCall: FunctionCall.create({ callId: 'move', name: 'transfer', args: '{}' }),
    });
    await done(handle);

    expect(session.currentAgent).toBe(original);
    expect(session.amd).toBe(detector);
    expect(detector.lifecycle).toBe(AMDLifecycle.ACTIVE);
    expect(replacement._agentActivity).toBeUndefined();
    const outputs = rt.chatCtx.items.filter((item) => item.type === 'function_call_output');
    expect(outputs).toHaveLength(1);
    expect(outputs[0]!.callId).toBe('move');
    expect(session.history.items).toContain(outputs[0]);
  });

  it('a tool follow-up keeps the stage instructions', async () => {
    const original = new Agent({
      instructions: 'Call about an appointment.',
      tools: {
        lookup: tool({
          description: 'Look up the appointment.',
          execute: async () => 'Tomorrow at 10 AM.',
        }),
      },
    });
    const { session, classifier, rt } = await running({ agent: original });
    const { handle } = await reply(session, classifier, rt, AMDCategory.MACHINE_SCREENING);
    expect(rt.replyInstructions).toEqual([DEFAULT_SCREENING_INSTRUCTIONS]);
    respond(rt, {
      toolCall: FunctionCall.create({ callId: 'lookup', name: 'lookup', args: '{}' }),
    });
    await eventually(() => rt.generateReplyCalls === 2);
    // Python passes the reply's instructions to its tool follow-up (#6202)
    expect(rt.replyInstructions).toEqual([
      DEFAULT_SCREENING_INSTRUCTIONS,
      DEFAULT_SCREENING_INSTRUCTIONS,
    ]);
    respond(rt);
    await done(handle);
  });

  it.each([false, true])(
    'IVR DTMF only generates a reply on failure (publish fails: %s)',
    async (publishFails) => {
      const publishDtmf = vi.fn(async () => {
        if (publishFails) {
          throw new Error('publish failed');
        }
      });
      const { session, classifier, rt } = await running();
      // after start: AgentSession reads the job context while it starts
      jobContext.current = {
        room: { localParticipant: { publishDtmf } },
        simulationContext: () => undefined,
      };
      onTestFinished(() => {
        jobContext.current = undefined;
      });
      const { handle } = await reply(session, classifier, rt, AMDCategory.MACHINE_IVR);
      expect(Object.keys(rt.replyTools[0]!.functionTools)).toEqual(['send_dtmf_events']);
      expect(session.currentAgent.toolCtx.tools).toEqual([]);
      respond(rt, {
        toolCall: FunctionCall.create({
          callId: 'dtmf-1',
          name: 'send_dtmf_events',
          args: '{"events": ["1"]}',
        }),
      });
      if (publishFails) {
        await eventually(() => rt.generateReplyCalls === 2);
        expect(rt.replyInstructions).toEqual([DEFAULT_IVR_INSTRUCTIONS, DEFAULT_IVR_INSTRUCTIONS]);
        expect(rt.replyTools[1]!.equals(rt.replyTools[0]!)).toBe(true);
        respond(rt);
      }
      await done(handle);
      expect(publishDtmf).toHaveBeenCalledExactlyOnceWith(1, '1');
      expect(rt.generateReplyCalls).toBe(publishFails ? 2 : 1);
      const outputs = rt.chatCtx.items.filter((item) => item.type === 'function_call_output');
      expect(outputs).toHaveLength(1);
      expect(outputs[0]!.isError).toBe(publishFails);
      expect(outputs[0]!.replyRequired).toBe(publishFails);
      expect(session.agentState).toBe('listening');

      const { handle: human } = await reply(session, classifier, rt, AMDCategory.HUMAN);
      expect(rt.replyTools[rt.replyTools.length - 1]).toBeUndefined();
      respond(rt);
      await done(human);
    },
  );

  it.each([false, true])(
    'voicemail is retried only after interrupted playout (interrupted: %s)',
    async (interrupted) => {
      const { detector, session, classifier, rt } = await running();
      const handles: SpeechHandle[] = [];
      session.on(AgentSessionEventTypes.SpeechCreated, (ev) => handles.push(ev.speechHandle));
      const { handle } = await reply(session, classifier, rt, AMDCategory.MACHINE_VM);
      expect(rt.replyInstructions[rt.replyInstructions.length - 1]).toBe(
        DEFAULT_VOICEMAIL_INSTRUCTIONS,
      );
      respond(rt, { duration: interrupted ? 10_000 : 10 });
      if (interrupted) {
        const output = session.output.audio as FakeAudioOutput;
        await eventually(() => output.pushedDuration > 0);
        session.interrupt();
      }
      await done(handle);
      expect(internals(detector).voicemailMessagePlayed).toBe(!interrupted);

      expect(await activityOf(session).onEndOfTurn(endOfTurn())).toBe(true);
      await classifier.request();
      classifier.prediction(2, AMDCategory.MACHINE_VM);
      await userTurnCompleted(session);
      if (interrupted) {
        await eventually(() => rt.generateReplyCalls === 2);
        respond(rt);
        await done(handles[handles.length - 1]!);
      } else {
        expect(rt.generateReplyCalls).toBe(1);
      }
    },
  );

  it('customer stop response prevents realtime generation', async () => {
    const { session, classifier, rt } = await running({ agent: new CustomerAgent({ stop: true }) });
    expect(await activityOf(session).onEndOfTurn(endOfTurn())).toBe(true);
    await classifier.request();
    classifier.prediction(1, AMDCategory.MACHINE_SCREENING);
    await userTurnCompleted(session);
    expect(rt.generateReplyCalls).toBe(0);
  });
});
