// SPDX-FileCopyrightText: 2026 LiveKit, Inc.
//
// SPDX-License-Identifier: Apache-2.0

/** Shared helpers for the AMD tests. Mirrors Python `tests/test_amd_detector.py` helpers. */
import { AudioFrame } from '@livekit/rtc-node';
import { expect, onTestFinished } from 'vitest';
import { asLanguageCode } from '../../language.js';
import {
  type ChatContext,
  ChatMessage,
  FunctionCall,
  FunctionCallOutput,
} from '../../llm/chat_context.js';
import { LLM, LLMStream } from '../../llm/llm.js';
import type { ToolChoice, ToolContextLike } from '../../llm/tool_context.js';
import { initializeLogger } from '../../log.js';
import { SpeechEventType, SpeechStream } from '../../stt/stt.js';
import { FakeSTT } from '../../stt/testing/fake_stt.js';
import { type ChunkedStream, SynthesizeStream, TTS } from '../../tts/tts.js';
import { type APIConnectOptions, DEFAULT_API_CONNECT_OPTIONS } from '../../types.js';
import { Event, Future, delay, shortuuid } from '../../utils.js';
import { Agent, StopResponse } from '../agent.js';
import { AgentSession, type AgentSessionOptions } from '../agent_session.js';
import type { EndOfTurnInfo } from '../audio_recognition.js';
import {
  AgentSessionEventTypes,
  type FunctionToolsExecutedEvent,
  createFunctionToolsExecutedEvent,
  createUserInputTranscribedEvent,
} from '../events.js';
import { AudioOutput } from '../io.js';
import type { SpeechHandle } from '../speech_handle.js';
import { FakeLLM } from '../testing/fake_llm.js';
import type { TurnHooks } from '../turn_hooks.js';
import type { AMDChatContext, Turn } from './chat_context.js';
import {
  AMD,
  type AMDOptions,
  DEFAULT_HUMAN_INSTRUCTIONS,
  DEFAULT_IVR_INSTRUCTIONS,
  DEFAULT_SCREENING_INSTRUCTIONS,
  DEFAULT_VOICEMAIL_INSTRUCTIONS,
} from './detector.js';
import { AMDCategory, AMDLifecycle, type AMDPredictionEvent } from './events.js';
import { CLASSIFY_PROMPT } from './inference.js';

initializeLogger({ pretty: false, level: 'silent' });

/** A FIFO with an awaitable `get`, like `asyncio.Queue`. */
export class AsyncQueue<T> {
  private items: T[] = [];
  private waiters: Array<(item: T) => void> = [];

  put(item: T): void {
    const waiter = this.waiters.shift();
    if (waiter) {
      waiter(item);
    } else {
      this.items.push(item);
    }
  }

  get empty(): boolean {
    return this.items.length === 0;
  }

  get size(): number {
    return this.items.length;
  }

  async get(timeoutMs = 2_000): Promise<T> {
    if (this.items.length > 0) {
      return this.items.shift()!;
    }
    return new Promise<T>((resolve, reject) => {
      const waiter = (item: T) => {
        clearTimeout(timer);
        resolve(item);
      };
      const timer = setTimeout(() => {
        this.waiters.splice(this.waiters.indexOf(waiter), 1);
        reject(new Error('timed out waiting for a queue item'));
      }, timeoutMs);
      this.waiters.push(waiter);
    });
  }
}

/** The fields a test reads from a classification request. */
export interface ClassifierRequest {
  stage: AMDCategory;
  previous_prediction: { category: string; reason: string; turn_id: number } | null;
  recommended_next_categories: AMDCategory[];
  speech_duration: number;
  currentTurn: ChatMessage;
  earlierTurns: ChatMessage[];
  chatCtx: ChatContext;
  toolCtx: ToolContextLike | undefined;
  toolChoice: ToolChoice | undefined;
  parallelToolCalls: boolean | undefined;
  connOptions: APIConnectOptions;
}

/** Controllable provider model. Tests use the real SDK inference path. */
export class ClassifierLLM extends LLM {
  readonly requests = new AsyncQueue<ClassifierRequest>();
  readonly menuRequests = new AsyncQueue<Future<string>>();
  readonly responses = new Map<number, Future<string>>();
  closed = false;

  label(): string {
    return 'classifier-llm';
  }

  override get model(): string {
    return 'classifier';
  }

  chat({
    chatCtx,
    toolCtx,
    connOptions = DEFAULT_API_CONNECT_OPTIONS,
    parallelToolCalls,
    toolChoice,
  }: {
    chatCtx: ChatContext;
    toolCtx?: ToolContextLike;
    connOptions?: APIConnectOptions;
    parallelToolCalls?: boolean;
    toolChoice?: ToolChoice;
    extraKwargs?: Record<string, unknown>;
  }): LLMStream {
    const response = new Future<string>();
    const first = chatCtx.items[0];
    if (first instanceof ChatMessage && first.textContent === CLASSIFY_PROMPT) {
      const data = JSON.parse((chatCtx.items[1] as ChatMessage).textContent ?? '{}');
      const messages = chatCtx.items.filter(
        (item): item is ChatMessage => item instanceof ChatMessage && item.role === 'user',
      );
      const current = messages[messages.length - 1]!;
      this.responses.set(current.extra.turn_id as number, response);
      this.requests.put({
        ...data,
        currentTurn: current,
        earlierTurns: messages.slice(0, -1),
        chatCtx: chatCtx.copy(),
        toolCtx,
        toolChoice,
        parallelToolCalls,
        connOptions,
      });
    } else {
      this.menuRequests.put(response);
    }
    return new ControlledStream(this, { chatCtx, toolCtx, connOptions, response });
  }

  async request(): Promise<ClassifierRequest> {
    return this.requests.get(2_000);
  }

  prediction(turnId: number, category: AMDCategory, extra: Record<string, unknown> = {}): void {
    this.respond(turnId, JSON.stringify({ category, ...extra }));
  }

  respond(turnId: number, args: string): void {
    const response = this.responses.get(turnId)!;
    if (!response.done) {
      response.resolve(args);
    }
  }

  override async aclose(): Promise<void> {
    this.closed = true;
    await super.aclose();
  }
}

export class ControlledStream extends LLMStream {
  private readonly response: Future<string>;

  constructor(
    model: LLM,
    {
      chatCtx,
      toolCtx,
      connOptions,
      response,
    }: {
      chatCtx: ChatContext;
      toolCtx?: ToolContextLike;
      connOptions: APIConnectOptions;
      response: Future<string>;
    },
  ) {
    super(model, {
      chatCtx,
      toolCtx: toolCtx as never,
      connOptions: { ...connOptions, maxRetry: 0 },
    });
    this.response = response;
  }

  protected async run(): Promise<void> {
    const args = await this.response.await;
    this.queue.put({
      id: 'amd-test',
      delta: {
        role: 'assistant',
        toolCalls: [FunctionCall.create({ name: 'record_result', args, callId: 'amd-test' })],
      },
    });
  }
}

/** Records every reply generation and answers each AMD stage prompt. */
export class RecordingLLM extends FakeLLM {
  readonly calls = new AsyncQueue<{
    chatCtx: ChatContext;
    toolCtx: ToolContextLike | undefined;
    toolChoice: ToolChoice | undefined;
  }>();

  constructor() {
    super(
      [
        DEFAULT_SCREENING_INSTRUCTIONS,
        DEFAULT_VOICEMAIL_INSTRUCTIONS,
        DEFAULT_IVR_INSTRUCTIONS,
        DEFAULT_HUMAN_INSTRUCTIONS,
        'hello',
      ].map((input) => ({ input, content: 'Please call me back.', ttft: 0, duration: 0 })),
    );
  }

  override chat(options: Parameters<FakeLLM['chat']>[0]): LLMStream {
    this.calls.put({
      chatCtx: options.chatCtx.copy(),
      toolCtx: options.toolCtx,
      toolChoice: options.toolChoice,
    });
    // Python's FakeLLM also answers a trailing system message, such as a hook's edit;
    // the JS FakeLLM reads only a trailing user message
    const last = options.chatCtx.items[options.chatCtx.items.length - 1];
    if (
      last instanceof ChatMessage &&
      last.role === 'system' &&
      last.textContent &&
      this.lookup(last.textContent) !== undefined
    ) {
      const chatCtx = options.chatCtx.copy();
      chatCtx.addMessage({ role: 'user', content: last.textContent });
      return super.chat({ ...options, chatCtx });
    }
    return super.chat(options);
  }
}

export class CustomerAgent extends Agent {
  readonly hooks: ChatContext[] = [];
  hookStarted = new Event();
  readonly hookRelease = new Event();
  stop: boolean;

  constructor({ stop = false }: { stop?: boolean } = {}) {
    super({ instructions: 'You are calling about an appointment.' });
    this.hookRelease.set();
    this.stop = stop;
  }

  override async onUserTurnCompleted(turnCtx: ChatContext, newMessage: ChatMessage) {
    this.hooks.push(turnCtx.copy());
    this.hookStarted.set();
    await this.hookRelease.wait();
    if (this.stop) {
      throw new StopResponse();
    }
    turnCtx.addMessage({
      role: 'system',
      content: 'Customer hook edit',
      // Python's float clock orders the edit after the turn's message; a millisecond tie would
      // put the inserted message last
      createdAt: Math.max(Date.now(), newMessage.createdAt + 0.001),
    });
  }
}

class FakeSynthesizeStream extends SynthesizeStream {
  label = 'fake-tts.stream';

  constructor(
    tts: FakeTTS,
    connOptions: APIConnectOptions,
    private readonly audioDuration: number,
  ) {
    super(tts, connOptions);
  }

  protected async run(): Promise<void> {
    let text = '';
    for await (const chunk of this.input) {
      if (typeof chunk === 'string') {
        text += chunk;
      }
    }
    if (!text || this.abortSignal.aborted) {
      return;
    }
    const sampleRate = 24_000;
    const samples = Math.round((sampleRate * this.audioDuration) / 1000);
    this.queue.put({
      requestId: 'fake',
      segmentId: 'fake',
      final: true,
      frame: new AudioFrame(new Int16Array(samples), sampleRate, 1, samples),
    });
  }
}

/** Streaming TTS that answers any text with `audioDuration` ms of silence. */
export class FakeTTS extends TTS {
  label = 'fake-tts';

  constructor(private readonly audioDuration = 50) {
    super(24_000, 1, { streaming: true });
  }

  synthesize(): ChunkedStream {
    throw new Error('streaming only');
  }

  stream(options?: { connOptions?: APIConnectOptions }): SynthesizeStream {
    return new FakeSynthesizeStream(
      this,
      options?.connOptions ?? DEFAULT_API_CONNECT_OPTIONS,
      this.audioDuration,
    );
  }
}

/** Plays captured audio in real time and reports each finished segment. */
export class FakeAudioOutput extends AudioOutput {
  private pushedDuration = 0;
  private timer: ReturnType<typeof setTimeout> | undefined;

  constructor() {
    super(24_000);
  }

  override async captureFrame(frame: AudioFrame): Promise<void> {
    const starting = this.pushedDuration === 0;
    await super.captureFrame(frame);
    this.pushedDuration += (frame.samplesPerChannel / frame.sampleRate) * 1000;
    if (starting) {
      this.onPlaybackStarted(Date.now());
    }
  }

  override flush(): void {
    super.flush();
    const pushed = this.pushedDuration;
    clearTimeout(this.timer);
    this.timer = setTimeout(() => {
      this.timer = undefined;
      this.pushedDuration = 0;
      if (this.pendingPlayoutSegments > 0) {
        this.onPlaybackFinished({ playbackPosition: pushed / 1000, interrupted: false });
      }
    }, pushed);
  }

  clearBuffer(): void {
    clearTimeout(this.timer);
    this.timer = undefined;
    const pushed = this.pushedDuration;
    this.pushedDuration = 0;
    super.flush();
    if (this.pendingPlayoutSegments > 0) {
      this.onPlaybackFinished({ playbackPosition: pushed / 1000, interrupted: true });
    }
  }
}

/** A streaming STT stream that records frames and stays open until released. */
export class DrainingStream extends SpeechStream {
  label = 'draining-stt.stream';
  readonly flushed = new Event();
  readonly inputEnded = new Event();
  readonly release = new Event();
  error: Error | undefined;
  readonly frames: AudioFrame[] = [];

  constructor(model: DrainingSTT, connOptions?: APIConnectOptions) {
    super(model, undefined, { ...(connOptions ?? DEFAULT_API_CONNECT_OPTIONS), maxRetry: 0 });
  }

  /** Emit a final transcript, as the provider would. */
  sendFinal(transcript: string): void {
    this.queue.put({
      type: SpeechEventType.FINAL_TRANSCRIPT,
      alternatives: [
        { text: transcript, language: asLanguageCode(''), startTime: 0, endTime: 0, confidence: 1 },
      ],
    });
  }

  protected async run(): Promise<void> {
    for await (const frame of this.input) {
      if (this.error !== undefined) {
        throw this.error;
      }
      if (frame === SpeechStream.FLUSH_SENTINEL) {
        this.flushed.set();
      } else {
        this.frames.push(frame);
      }
    }
    this.inputEnded.set();
    await this.release.wait();
  }
}

export class DrainingSTT extends FakeSTT {
  readonly streams: DrainingStream[] = [];

  override stream(options?: { connOptions?: APIConnectOptions }): never {
    const stream = new DrainingStream(this, options?.connOptions);
    this.streams.push(stream);
    return stream as never;
  }
}

/** Private AMD state the tests read and drive. Mirrors Python's `detector._x` access. */
export interface AMDInternals {
  turns: Map<number, Turn>;
  _turnId: number;
  _state: AMDCategory;
  _shouldWait: boolean;
  _heldTurnId: number | undefined;
  _heldReply: SpeechHandle | undefined;
  _shouldReply(
    turnId: number,
    chatCtx: ChatContext,
  ): Promise<{ allow: boolean; instructionsFor?: AMDCategory; trackVoicemail?: boolean }>;
  _deadlineAt(now: number): number | undefined;
  _updateIdle(): void;
  _getInstructions(stage: AMDCategory): string;
  _trackVoicemail(turnId: number, handle: SpeechHandle): void;
  _onUserTurnCommitted(transcript: string, endOfTurnDelay: number | undefined): TurnHooks;
  chatCtx: AMDChatContext;
  category: AMDCategory;
  latest: AMDPredictionEvent | null;
  hardDeadline: number | undefined;
  inferenceDeadline: number | undefined;
  idleDeadline: number | undefined;
  speechStartedAt: number | undefined;
  speechEndedAt: number | undefined;
  speechDuration: number;
  pendingTurn: Turn | undefined;
  uncertainTurns: number;
  inferenceTimeouts: number;
  voicemailTurnId: number | undefined;
  voicemailMessagePlayed: boolean;
  voicemailHandle: SpeechHandle | undefined;
  previousStage: AMDCategory | undefined;
  hadMachineStage: boolean;
  speeches: Set<SpeechHandle>;
  sessionId: string;
  controlPrefix: string;
  timer: ReturnType<typeof setTimeout> | undefined;
  classifierTask: unknown;
  menuTask: unknown;
  tasks: Set<unknown>;
  finishTask: Promise<void> | undefined;
  options: Required<
    Pick<
      AMDOptions,
      | 'idleTimeout'
      | 'voicemailIdleTimeout'
      | 'timeout'
      | 'inferenceTimeout'
      | 'machineSilenceThreshold'
      | 'maxUncertainTurns'
      | 'maxInferenceTimeouts'
    >
  >;
  llm: LLM | undefined;
  stt: unknown;
  run:
    | {
        llm: LLM;
        stt: {
          pushAudio(frame: AudioFrame): void;
          pushTranscript(transcript: string, opts?: { replace?: boolean }): void;
          amdSttActive: boolean;
        };
      }
    | undefined;
}

export function internals(detector: AMD): AMDInternals {
  return detector as unknown as AMDInternals;
}

/** Earliest armed detector deadline on the monotonic clock. */
export function nextDeadline(detector: AMD): number | undefined {
  return internals(detector)._deadlineAt(performance.now());
}

export function endOfTurn(
  transcript = 'hello',
  { skipReply = false }: { skipReply?: boolean } = {},
): EndOfTurnInfo {
  return {
    skipReply,
    newTranscript: transcript,
    transcriptConfidence: 1,
    transcriptionDelay: undefined,
    endOfUtteranceDelay: undefined,
    startedSpeakingAt: undefined,
    stoppedSpeakingAt: undefined,
  };
}

export function audioFrame(): AudioFrame {
  return new AudioFrame(new Int16Array(320), 16_000, 1, 320);
}

export function pushAudio(detector: AMD, stt: DrainingSTT): DrainingStream {
  detector.pushAudio(audioFrame());
  return stt.streams[stt.streams.length - 1]!;
}

export function commitTurn(detector: AMD, info: EndOfTurnInfo): TurnHooks {
  const hooks = sessionOf(detector)._turnHooks;
  expect(hooks).toBeDefined();
  return hooks!.onUserTurnCommitted(info.newTranscript, info.endOfUtteranceDelay);
}

export function sessionOf(detector: AMD): AgentSession {
  return (detector as unknown as { session: AgentSession }).session;
}

export function speechStarted(detector: AMD): void {
  sessionOf(detector)._updateUserState('speaking');
}

/** End user speech that stopped `silenceDuration` ms ago. */
export function speechEnded(detector: AMD, silenceDuration: number): void {
  sessionOf(detector)._updateUserState('listening', {
    lastSpeakingTime: Date.now() - silenceDuration,
  });
}

export function transcribe(detector: AMD, transcript: string): void {
  sessionOf(detector).emit(
    AgentSessionEventTypes.UserInputTranscribed,
    createUserInputTranscribedEvent({ transcript, isFinal: true }),
  );
}

export function dtmfExecuted(
  session: AgentSession,
  digits: string,
  {
    isError = false,
    name = 'send_dtmf_events',
    createdAt,
  }: { isError?: boolean; name?: string; createdAt?: number } = {},
): FunctionToolsExecutedEvent {
  const call = FunctionCall.create({
    callId: shortuuid('dtmf_'),
    name,
    args: JSON.stringify({ events: [...digits] }),
    createdAt: createdAt ?? Date.now(),
  });
  const event = createFunctionToolsExecutedEvent({
    functionCalls: [call],
    functionCallOutputs: [
      FunctionCallOutput.create({
        callId: call.callId,
        name,
        output: isError ? 'Send failed' : `Successfully sent DTMF events: ${digits}`,
        isError,
      }),
    ],
  });
  session.emit(AgentSessionEventTypes.FunctionToolsExecuted, event);
  return event;
}

export function dtmfCalls(chatCtx: ChatContext): FunctionCall[] {
  return chatCtx.items.filter((item): item is FunctionCall => item instanceof FunctionCall);
}

/** Wait until `predicate` holds, failing after `timeoutMs`. */
export async function eventually(predicate: () => boolean, timeoutMs = 2_000): Promise<void> {
  const startedAt = Date.now();
  while (!predicate()) {
    if (Date.now() - startedAt > timeoutMs) {
      throw new Error('timed out waiting for condition');
    }
    await delay(1);
  }
}

/** Reject if `promise` does not settle within `timeoutMs`, like `asyncio.wait_for`. */
export async function waitFor<T>(promise: Promise<T>, timeoutMs = 2_000): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error('timed out')), timeoutMs);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

export interface RunningOptions extends AMDOptions {
  classifier?: ClassifierLLM;
  agent?: Agent;
  sessionOptions?: Partial<AgentSessionOptions>;
}

export interface Running {
  detector: AMD;
  session: AgentSession;
  classifier: ClassifierLLM;
  model: RecordingLLM;
  agent: Agent;
}

/**
 * Start a session and an active AMD on it. Closes both when the test finishes, like Python's
 * `async with running() as (...)`.
 */
export async function running({
  classifier = new ClassifierLLM(),
  agent = new CustomerAgent(),
  sessionOptions = {},
  ...options
}: RunningOptions = {}): Promise<Running> {
  const model = new RecordingLLM();
  const session = new AgentSession({
    llm: model,
    tts: new FakeTTS(50),
    turnHandling: { turnDetection: 'manual' },
    aecWarmupDuration: null,
    ...sessionOptions,
  } as AgentSessionOptions);
  session.output.audio = new FakeAudioOutput();
  await session.start({ agent });
  const detector = new AMD(session, {
    llm: classifier,
    machineSilenceThreshold: 0,
    stt: null,
    ...options,
  });
  onTestFinished(async () => {
    await detector.aclose();
    await session.close();
  });
  await detector.start();
  await eventually(() => detector.lifecycle === AMDLifecycle.ACTIVE);
  return { detector, session, classifier, model, agent };
}

/** Commit a turn and wait for its classification request. */
export async function commit(
  detector: AMD,
  session: AgentSession,
  classifier: ClassifierLLM,
  { reply = false }: { reply?: boolean } = {},
): Promise<TurnHooks | undefined> {
  const info = endOfTurn();
  let hooks: TurnHooks | undefined;
  if (reply) {
    void session._activity!.onEndOfTurn(info);
  } else {
    hooks = commitTurn(detector, info);
  }
  const request = await classifier.request();
  expect(request.currentTurn.extra.turn_id).toBe(internals(detector)._turnId);
  return hooks;
}

/** Commit and classify the turn that confirms a human after a menu or screener. */
export async function confirmHuman(
  detector: AMD,
  classifier: ClassifierLLM,
  text = 'Hello, who is this?',
): Promise<TurnHooks> {
  const held = internals(detector)._turnId;
  await eventually(() => internals(detector).turns.get(held)!.prediction !== null);
  const hooks = commitTurn(detector, endOfTurn(text));
  const request = await classifier.request();
  classifier.prediction(request.currentTurn.extra.turn_id as number, AMDCategory.HUMAN);
  return hooks;
}
