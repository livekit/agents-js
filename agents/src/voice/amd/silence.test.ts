// SPDX-FileCopyrightText: 2026 LiveKit, Inc.
//
// SPDX-License-Identifier: Apache-2.0

/** Ported from Python `tests/test_amd_silence.py`. */
import { AudioFrame } from '@livekit/rtc-node';
import { describe, expect, it, onTestFinished, vi } from 'vitest';
import { ChatContext, ChatMessage } from '../../llm/chat_context.js';
import { tool } from '../../llm/tool_context.js';
import { SpeechEventType } from '../../stt/stt.js';
import { FakeSTT } from '../../stt/testing/fake_stt.js';
import { Future, Event as SignalEvent } from '../../utils.js';
import { VAD, type VADEvent, VADEventType, VADStream } from '../../vad.js';
import { Agent } from '../agent.js';
import type { AgentActivity } from '../agent_activity.js';
import { AgentSession, type AgentSessionOptions } from '../agent_session.js';
import {
  AgentSessionEventTypes,
  type UserStateChangedEvent,
  createUserStateChangedEvent,
} from '../events.js';
import { SpeechHandle } from '../speech_handle.js';
import { FakeLLM } from '../testing/fake_llm.js';
import type { TurnHooks } from '../turn_hooks.js';
import {
  ClassifierLLM,
  CustomerAgent,
  DrainingSTT,
  FakeAudioOutput,
  FakeTTS,
  RecordingLLM,
  type Running,
  type RunningOptions,
  commit,
  commitTurn,
  endOfTurn,
  internals,
  nextDeadline,
  pushAudio,
  running,
  speechEnded,
  speechStarted,
} from './amd_test_utils.js';
import { AMD, DEFAULT_SCREENING_INSTRUCTIONS } from './detector.js';
import {
  AMDCategory,
  type AMDCompletedEvent,
  AMDLifecycle,
  type AMDPredictionEvent,
  AMDReason,
} from './events.js';

// Lets one test replace classification, like Python's `monkeypatch.setattr(_inference, ...)`.
const classifyOverride = vi.hoisted(() => ({
  fn: undefined as undefined | ((...args: unknown[]) => Promise<unknown>),
}));
vi.mock('./inference.js', async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  const classify = actual.classify as (...args: unknown[]) => Promise<unknown>;
  return {
    ...actual,
    classify: (...args: unknown[]) => (classifyOverride.fn ?? classify)(...args),
  };
});

// region: virtual time, like Python's `pytest.mark.virtual_time`

function useVirtualTime(): void {
  vi.useFakeTimers({
    toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'performance', 'Date'],
  });
  onTestFinished(() => {
    vi.useRealTimers();
  });
}

const now = (): number => performance.now();

const macrotask = (): Promise<void> => new Promise((resolve) => setImmediate(resolve));

/** One idle loop turn: run ready I/O, then timers already due, without moving the clock. */
async function readyTurn(): Promise<void> {
  await macrotask();
  await vi.advanceTimersByTimeAsync(0);
}

/** Event-loop turns to run before the virtual clock may move, like an idle asyncio loop. */
const READY_TURNS = 10;

/** Let ready work run; advance virtual time only when nothing else can progress. */
async function settle<T>(promise: Promise<T>, maxMs = 2_000): Promise<T> {
  let done = false;
  let failed = false;
  let value: T | undefined;
  let error: unknown;
  promise.then(
    (result) => {
      done = true;
      value = result;
    },
    (reason) => {
      done = true;
      failed = true;
      error = reason;
    },
  );
  for (let elapsed = 0; ; elapsed++) {
    for (let turn = 0; turn < READY_TURNS && !done; turn++) {
      await readyTurn();
    }
    if (done) {
      break;
    }
    if (elapsed >= maxMs) {
      throw new Error('timed out');
    }
    await vi.advanceTimersByTimeAsync(1);
  }
  if (failed) {
    throw error;
  }
  return value as T;
}

/** `asyncio.sleep(ms)` on the virtual clock. */
async function sleep(ms: number): Promise<void> {
  const target = now() + ms;
  await macrotask();
  while (now() < target) {
    await vi.advanceTimersByTimeAsync(Math.min(1, target - now()));
    await macrotask();
  }
}

async function eventually(predicate: () => unknown, maxMs = 2_000): Promise<void> {
  const started = now();
  for (;;) {
    for (let turn = 0; turn < READY_TURNS; turn++) {
      if (predicate()) {
        return;
      }
      await readyTurn();
    }
    if (now() - started > maxMs) {
      throw new Error('timed out waiting for condition');
    }
    await vi.advanceTimersByTimeAsync(1);
  }
}

/** Close AMD and the session while virtual time keeps running. */
function closeAtEnd(detector: AMD, session: AgentSession): void {
  onTestFinished(async () => {
    await settle(
      (async () => {
        await detector.aclose();
        await session.close();
      })(),
      10_000,
    );
  });
}

async function start(options: RunningOptions = {}): Promise<Running> {
  useVirtualTime();
  const env = await running(options);
  closeAtEnd(env.detector, env.session);
  return env;
}

// endregion

// region: helpers

function activityOf(session: AgentSession): AgentActivity {
  return session._activity!;
}

function playbackAllowed(session: AgentSession): boolean {
  return !(activityOf(session) as unknown as { _authorizationPaused: boolean })
    ._authorizationPaused;
}

async function playbackReleased(session: AgentSession, maxMs = 5_000): Promise<void> {
  await eventually(() => playbackAllowed(session), maxMs);
}

function replyHeldAt(detector: AMD, at = now()): boolean {
  return (detector as unknown as { replyHeldAt(now: number): boolean }).replyHeldAt(at);
}

interface DetectorState {
  speechStartedAt: number | undefined;
  speechSinceCommit: boolean;
  speechEndedAt: number | undefined;
  participantIdentity: string | undefined;
  classifierTask: { result: Promise<void> } | undefined;
  onUserStateChanged(event: UserStateChangedEvent): void;
  onDisconnected(participant: { identity: string }): void;
}

function state(detector: AMD): DetectorState {
  return detector as unknown as DetectorState;
}

interface RecognitionState {
  turnDetectionMode: string | undefined;
  vad: VAD | undefined;
  runEOUDetection: unknown;
  onSTTEvent(event: {
    type: SpeechEventType;
    speechStartTime?: number;
    speechEndTime?: number;
  }): Promise<void>;
}

function recognitionOf(session: AgentSession): RecognitionState {
  return (activityOf(session) as unknown as { audioRecognition: RecognitionState })
    .audioRecognition;
}

function onPrediction(detector: AMD): AMDPredictionEvent[] {
  const events: AMDPredictionEvent[] = [];
  detector.on('amd_prediction', (event) => events.push(event));
  return events;
}

function onSpeech(session: AgentSession): SpeechHandle[] {
  const speeches: SpeechHandle[] = [];
  session.on(AgentSessionEventTypes.SpeechCreated, (event) => speeches.push(event.speechHandle));
  return speeches;
}

function prediction(detector: AMD, turnId: number): AMDPredictionEvent {
  const event = internals(detector).turns.get(turnId)!.prediction;
  expect(event).not.toBeNull();
  return event!;
}

async function execute(detector: AMD, maxMs = 2_000): Promise<AMDCompletedEvent> {
  return settle(detector.execute(), maxMs);
}

function vadEvent(
  type: VADEventType.START_OF_SPEECH | VADEventType.END_OF_SPEECH,
  options: Partial<VADEvent> = {},
): VADEvent {
  return {
    type,
    samplesIndex: 0,
    timestamp: 0,
    speechDuration: 0,
    silenceDuration: 0,
    frames: [],
    probability: 1,
    inferenceDuration: 0,
    speaking: type === VADEventType.START_OF_SPEECH,
    rawAccumulatedSilence: 0,
    rawAccumulatedSpeech: 0,
    ...options,
  };
}

/** A VAD whose events the test emits by hand, like Python's `recognition._on_vad_event`. */
class ScriptedVADStream extends VADStream {
  constructor(vad: VAD) {
    super(vad);
    void this.drain();
  }

  private async drain(): Promise<void> {
    try {
      while (!this.closed) {
        const { done } = await this.inputReader.read();
        if (done) break;
      }
    } catch {
      /* stream detached/closed */
    }
  }

  emitEvent(event: VADEvent): void {
    this.sendVADEvent(event);
  }
}

class ScriptedVAD extends VAD {
  label = 'scripted-vad';
  readonly streams: ScriptedVADStream[] = [];

  constructor() {
    super({ updateInterval: 32 });
  }

  stream(): ScriptedVADStream {
    const stream = new ScriptedVADStream(this);
    this.streams.push(stream);
    return stream;
  }

  async inject(event: VADEvent): Promise<void> {
    await eventually(() => this.streams.length > 0);
    this.streams[this.streams.length - 1]!.emitEvent(event);
    // the recognition task reads the event on its own loop
    for (let turn = 0; turn < READY_TURNS; turn++) {
      await macrotask();
    }
  }
}

async function sessionWith(options: AgentSessionOptions, agent: Agent): Promise<AgentSession> {
  const session = new AgentSession(options);
  session.output.audio = new FakeAudioOutput();
  await session.start({ agent });
  return session;
}

// endregion

describe('AMD machine silence', () => {
  it('machine silence default and validation', () => {
    expect(
      internals(new AMD(new AgentSession({}), { llm: null, stt: null })).options
        .machineSilenceThreshold,
    ).toBe(1_500);
    expect(() => new AMD(new AgentSession({}), { machineSilenceThreshold: -1 })).toThrow(
      'machineSilenceThreshold',
    );
  });

  it.each([
    AMDCategory.MACHINE_SCREENING,
    AMDCategory.MACHINE_VM,
    AMDCategory.MACHINE_IVR,
    AMDCategory.MACHINE_UNAVAILABLE,
  ])('machine prediction updates state before reply silence (%s)', async (category) => {
    const { detector, session, classifier, model } = await start({
      machineSilenceThreshold: 1_500,
      inferenceTimeout: 300,
    });
    const events = onPrediction(detector);
    speechStarted(detector);
    speechEnded(detector, 500);
    await commit(detector, session, classifier, { reply: true });
    await sleep(200);
    classifier.prediction(1, category);
    await sleep(700);
    expect(events).toHaveLength(1);
    expect(events[0]!.category).toBe(category);
    expect(events[0]!.reason).toBe(AMDReason.PREDICTION);
    expect(Math.abs(events[0]!.delay - 200)).toBeLessThanOrEqual(10);
    expect(Math.abs(events[0]!.inferenceDuration! - 200)).toBeLessThanOrEqual(10);
    expect(internals(detector)._state).toBe(category);
    prediction(detector, 1);
    if (category === AMDCategory.MACHINE_UNAVAILABLE) {
      expect(model.calls.empty).toBe(true);
      expect((await execute(detector)).category).toBe(category);
      return;
    }
    expect(detector.lifecycle).toBe(AMDLifecycle.ACTIVE);
    expect(replyHeldAt(detector)).toBe(true);
    expect(model.calls.empty).toBe(false);
    expect(playbackAllowed(session)).toBe(false);
    expect(Math.abs(nextDeadline(detector)! - now() - 100)).toBeLessThanOrEqual(10);
    await sleep(110);
    expect(events).toHaveLength(1);
    expect(playbackAllowed(session)).toBe(true);
  });

  it.each([AMDCategory.HUMAN, AMDCategory.UNCERTAIN])(
    'human and initial uncertain do not wait (%s)',
    async (category) => {
      const { detector, session, classifier } = await start({ machineSilenceThreshold: 1_500 });
      speechStarted(detector);
      speechEnded(detector, 0);
      const hooks = (await commit(detector, session, classifier))!;
      classifier.prediction(1, category);
      expect(await settle(hooks.shouldReply(new ChatContext()))).toBe(true);
      expect(prediction(detector, 1).category).toBe(category);
      expect(prediction(detector, 1).delay).toBeLessThan(10);
    },
  );

  it('elapsed silence and slow inference do not add another wait', async () => {
    const { detector, session, classifier } = await start({
      machineSilenceThreshold: 1_500,
      inferenceTimeout: 3_000,
    });
    speechStarted(detector);
    speechEnded(detector, 500);
    const hooks = (await commit(detector, session, classifier))!;
    await sleep(1_200);
    classifier.prediction(1, AMDCategory.MACHINE_SCREENING);
    expect(await settle(hooks.shouldReply(new ChatContext()))).toBe(true);
    expect(Math.abs(prediction(detector, 1).delay - 1_200)).toBeLessThanOrEqual(10);
  });

  it.each(['prediction', 'inference_timeout', 'inference_error', 'reused'])(
    'machine fallbacks and uncertain keep the silence wait (%s)',
    async (reason) => {
      const { detector, session, classifier } = await start({
        machineSilenceThreshold: 1_500,
        inferenceTimeout: 200,
      });
      speechStarted(detector);
      speechEnded(detector, 1_500);
      const first = (await commit(detector, session, classifier))!;
      classifier.prediction(1, AMDCategory.MACHINE_SCREENING);
      expect(await settle(first.shouldReply(new ChatContext()))).toBe(true);
      const events = onPrediction(detector);
      speechStarted(detector);
      speechEnded(detector, 500);
      let hooks: TurnHooks;
      if (reason === 'reused') {
        hooks = commitTurn(detector, endOfTurn(''));
      } else {
        hooks = (await commit(detector, session, classifier))!;
        if (reason === 'prediction') {
          classifier.prediction(2, AMDCategory.UNCERTAIN);
        } else if (reason === 'inference_error') {
          classifier.respond(2, 'invalid JSON');
        }
      }
      const ctx = new ChatContext();
      const reply = hooks.shouldReply(ctx);
      await sleep(900);
      const fallback = prediction(detector, 2);
      expect(events).toHaveLength(1);
      expect(fallback.reason).toBe(reason);
      // uncertain keeps the screening stage, so its reply waits for silence too;
      // a turn without a prediction is uncertain, and an empty turn repeats the last
      expect(fallback.category).toBe(
        reason === 'reused' ? AMDCategory.MACHINE_SCREENING : AMDCategory.UNCERTAIN,
      );
      expect(fallback.stage).toBe(AMDCategory.MACHINE_SCREENING);
      expect(await settle(reply)).toBe(true);
      expect((ctx.items[ctx.items.length - 1] as ChatMessage).extra.amd_stage).toBe(
        'machine-screening',
      );
      expect(playbackAllowed(session)).toBe(false);
      await sleep(110);
      expect(playbackAllowed(session)).toBe(true);
      expect(classifier.requests.empty).toBe(true);
    },
  );

  it('resumed speech invalidates release and preserves history', async () => {
    const { detector, session, classifier } = await start({ machineSilenceThreshold: 1_500 });
    const events = onPrediction(detector);
    speechStarted(detector);
    speechEnded(detector, 500);
    const hooks = (await commit(detector, session, classifier))!;
    classifier.prediction(1, AMDCategory.MACHINE_VM);
    await sleep(500);
    speechStarted(detector);
    await sleep(1_000);
    speechEnded(detector, 500);
    await sleep(500);
    expect(events.map((e) => e.category)).toEqual([AMDCategory.MACHINE_VM]);
    expect(replyHeldAt(detector)).toBe(true);
    prediction(detector, 1);
    commitTurn(detector, endOfTurn('Hello, can you hear me?'));
    const request = await settle(classifier.request());
    expect(request.earlierTurns[0]!.textContent).toBe('hello');
    expect(request.stage).toBe(AMDCategory.MACHINE_VM);
    expect(request.recommended_next_categories).not.toContain(AMDCategory.MACHINE_SCREENING);
    expect(await settle(hooks.shouldReply(new ChatContext()))).toBe(false);
    classifier.prediction(2, AMDCategory.HUMAN);
    expect((await execute(detector)).category).toBe(AMDCategory.HUMAN);
    expect(events.map((e) => e.category)).toEqual([AMDCategory.MACHINE_VM, AMDCategory.HUMAN]);
  });

  it.each(['vad', 'stt'])(
    'untranscribed speech rearms the committed prediction (%s)',
    async (source) => {
      useVirtualTime();
      const classifier = new ClassifierLLM();
      const model = new RecordingLLM();
      const vad = source === 'vad' ? new ScriptedVAD() : undefined;
      const session = await sessionWith(
        {
          llm: model,
          stt: new FakeSTT(),
          tts: new FakeTTS(50),
          vad,
          turnHandling: { turnDetection: source === 'vad' ? 'vad' : 'stt' },
          aecWarmupDuration: null,
        },
        new CustomerAgent(),
      );
      const detector = new AMD(session, {
        llm: classifier,
        stt: null,
        machineSilenceThreshold: 1_500,
        inferenceTimeout: 3_000,
      });
      closeAtEnd(detector, session);
      await detector.start();
      await eventually(() => detector.lifecycle === AMDLifecycle.ACTIVE);
      const recognition = recognitionOf(session);
      const events = onPrediction(detector);
      const speeches = onSpeech(session);
      await commit(detector, session, classifier, { reply: true });
      classifier.prediction(1, AMDCategory.MACHINE_SCREENING);
      await settle(model.calls.get());
      await sleep(500);
      prediction(detector, 1);
      expect(replyHeldAt(detector)).toBe(true);
      expect(playbackAllowed(session)).toBe(false);
      expect(nextDeadline(detector)).toBeDefined();
      expect(Math.abs(nextDeadline(detector)! - now() - 1_000)).toBeLessThanOrEqual(10);

      if (vad) {
        await vad.inject(vadEvent(VADEventType.START_OF_SPEECH));
      } else {
        await recognition.onSTTEvent({ type: SpeechEventType.START_OF_SPEECH });
      }
      await sleep(1_100);
      expect(events).toHaveLength(1);
      expect(replyHeldAt(detector)).toBe(true);
      expect(playbackAllowed(session)).toBe(false);
      expect(session.agentState).not.toBe('speaking');

      if (vad) {
        await vad.inject(
          vadEvent(VADEventType.END_OF_SPEECH, { speechDuration: 600, silenceDuration: 500 }),
        );
      } else {
        await recognition.onSTTEvent({
          type: SpeechEventType.END_OF_SPEECH,
          speechEndTime: Date.now() - 500,
        });
      }
      await sleep(900);
      expect(events).toHaveLength(1);
      expect(replyHeldAt(detector)).toBe(true);
      expect(playbackAllowed(session)).toBe(false);
      expect(session.agentState).not.toBe('speaking');
      await sleep(110);
      expect(playbackAllowed(session)).toBe(true);
      expect(events.map((e) => [e.turnId, e.category, e.transcript])).toEqual([
        [1, AMDCategory.MACHINE_SCREENING, 'hello'],
      ]);
      expect(internals(detector)._turnId).toBe(1);
      expect(classifier.requests.empty).toBe(true);
      expect(speeches).toHaveLength(1);
      await settle(speeches[0]!.waitForPlayout());
      expect(speeches[0]!.interrupted).toBe(false);
      expect(model.calls.empty).toBe(true);
    },
  );

  it('late human cannot replace a held timeout', async () => {
    const response = new Future<{ category: AMDCategory }>();
    const cancelled = new SignalEvent();
    const actual = await vi.importActual<{ classify: (...args: unknown[]) => Promise<unknown> }>(
      './inference.js',
    );
    classifyOverride.fn = async (...args: unknown[]) => {
      const request = args[1] as { chatCtx: ChatContext };
      const messages = request.chatCtx.items.filter(
        (item): item is ChatMessage => item instanceof ChatMessage,
      );
      if (messages[messages.length - 1]!.extra.turn_id !== 2) {
        return actual.classify(...args);
      }
      // ignore cancellation, like a provider that returns late
      const signal = (args[2] as { signal?: AbortSignal } | undefined)?.signal;
      signal?.addEventListener('abort', () => cancelled.set(), { once: true });
      return response.await;
    };
    onTestFinished(() => {
      classifyOverride.fn = undefined;
    });
    const { detector, session, classifier } = await start({
      machineSilenceThreshold: 1_500,
      inferenceTimeout: 200,
    });
    try {
      speechStarted(detector);
      speechEnded(detector, 1_500);
      const first = (await commit(detector, session, classifier))!;
      classifier.prediction(1, AMDCategory.MACHINE_VM);
      await settle(first.shouldReply(new ChatContext()));
      const events = onPrediction(detector);
      speechStarted(detector);
      speechEnded(detector, 0);
      commitTurn(detector, endOfTurn());
      const task = state(detector).classifierTask!;
      await settle(cancelled.wait(), 300);
      expect(response.done).toBe(false);
      expect(replyHeldAt(detector)).toBe(true);
      expect(events.map((e) => e.reason)).toEqual([AMDReason.INFERENCE_TIMEOUT]);
      response.resolve({ category: AMDCategory.HUMAN });
      await settle(task.result);
      await sleep(1_310);
      expect(detector.lifecycle).toBe(AMDLifecycle.ACTIVE);
      expect(internals(detector)._state).toBe(AMDCategory.MACHINE_VM);
      expect(events.map((e) => e.category)).toEqual([AMDCategory.UNCERTAIN]);
      expect(events[0]!.reason).toBe(AMDReason.INFERENCE_TIMEOUT);
    } finally {
      if (!response.done) {
        response.resolve({ category: AMDCategory.HUMAN });
      }
    }
  });

  it('late machine prediction cannot replace an empty turn hold', async () => {
    const { detector, session, classifier, model } = await start({
      machineSilenceThreshold: 1_500,
      inferenceTimeout: 200,
    });
    const amd = internals(detector);
    const events = onPrediction(detector);
    speechStarted(detector);
    speechEnded(detector, 1_500);
    const first = (await commit(detector, session, classifier))!;
    classifier.prediction(1, AMDCategory.MACHINE_VM);
    expect(await settle(first.shouldReply(new ChatContext()))).toBe(true);
    const handle = SpeechHandle.create();
    first.onAgentTurnCommitted(handle);
    const output = session.output.audio!;
    await output.captureFrame(new AudioFrame(new Int16Array(24), 24_000, 1, 24));
    output.flush();
    await settle(output.waitForPlayout());
    handle._markDone();
    await settle(handle.waitForPlayout());

    speechStarted(detector);
    speechEnded(detector, 1_500);
    const second = (await commit(detector, session, classifier))!;
    expect(await settle(second.shouldReply(new ChatContext()))).toBe(false);
    const fallback = prediction(detector, 2);
    expect(fallback.reason).toBe(AMDReason.INFERENCE_TIMEOUT);
    const fallbackSnapshot = { ...fallback };

    speechStarted(detector);
    speechEnded(detector, 0);
    const activity = activityOf(session);
    expect(await activity.onEndOfTurn(endOfTurn(''))).toBe(true);
    const replyTask = activity._userTurnCompletedTask;
    expect(replyTask).toBeDefined();
    const releaseAt = nextDeadline(detector);
    expect(releaseAt).toBeDefined();
    expect(amd._turnId).toBe(3);
    expect(prediction(detector, 3).reason).toBe(AMDReason.REUSED);
    expect(replyHeldAt(detector)).toBe(true);
    await sleep(400);
    classifier.prediction(2, AMDCategory.MACHINE_UNAVAILABLE);
    await sleep(100);
    expect(nextDeadline(detector)).toBe(releaseAt);
    expect(amd.turns.get(2)!.prediction).toBe(fallback);
    expect(fallback).toEqual(fallbackSnapshot);

    await sleep(releaseAt! - now() - 100);
    expect(model.calls.empty).toBe(true);
    const expected = [
      [1, AMDReason.PREDICTION],
      [2, AMDReason.INFERENCE_TIMEOUT],
      [3, AMDReason.REUSED],
    ];
    expect(events.map((e) => [e.turnId, e.reason])).toEqual(expected);
    await sleep(110);
    expect(amd._state).toBe(AMDCategory.MACHINE_VM);
    expect(detector.lifecycle).toBe(AMDLifecycle.ACTIVE);
    prediction(detector, 3);
    expect(amd.turns.get(2)!.prediction).toBe(fallback);
    expect(fallback).toEqual(fallbackSnapshot);
    expect(events.map((e) => [e.turnId, e.reason])).toEqual(expected);
    await settle(replyTask!.result);
    expect(model.calls.empty).toBe(true);
    expect(classifier.requests.empty).toBe(true);
  });

  it.each([1, 3, 4])(
    'inference timeout limit waits for silence before completion (%i)',
    async (limit) => {
      const { detector, session, classifier } = await start({
        machineSilenceThreshold: 1_500,
        inferenceTimeout: 200,
        maxInferenceTimeouts: limit,
      });
      speechStarted(detector);
      speechEnded(detector, 1_500);
      const first = (await commit(detector, session, classifier))!;
      classifier.prediction(1, AMDCategory.MACHINE_SCREENING);
      await settle(first.shouldReply(new ChatContext()));
      for (let turnId = 2; turnId < limit + 2; turnId++) {
        speechStarted(detector);
        speechEnded(detector, 500);
        await commit(detector, session, classifier);
        await sleep(300);
        expect(detector.lifecycle).toBe(AMDLifecycle.ACTIVE);
        expect(prediction(detector, turnId).reason).toBe(AMDReason.INFERENCE_TIMEOUT);
        expect(replyHeldAt(detector)).toBe(true);
        await sleep(710);
        prediction(detector, turnId);
      }
      expect((await execute(detector)).reason).toBe(AMDReason.INFERENCE_TIMEOUT);
    },
  );

  it.each([true, false])(
    'empty eot after resumed speech rearms a useful prediction (inference ready: %s)',
    async (inferenceReady) => {
      const { detector, session, classifier } = await start({
        machineSilenceThreshold: 1_500,
        inferenceTimeout: 3_000,
      });
      const events = onPrediction(detector);
      speechStarted(detector);
      speechEnded(detector, 500);
      await commit(detector, session, classifier);
      if (inferenceReady) {
        classifier.prediction(1, AMDCategory.MACHINE_SCREENING);
      }
      await sleep(200);
      speechStarted(detector);
      speechEnded(detector, 500);
      commitTurn(detector, endOfTurn(''));
      if (!inferenceReady) {
        classifier.prediction(1, AMDCategory.MACHINE_SCREENING);
      }
      // an empty turn reuses the prediction and emits its own reused event,
      // whether it was committed after the prediction or while it was pending
      const expected = [
        [1, AMDReason.PREDICTION],
        [2, AMDReason.REUSED],
      ];
      await sleep(900);
      expect(events.map((e) => [e.turnId, e.reason])).toEqual(expected);
      expect(replyHeldAt(detector)).toBe(true);
      await sleep(110);
      expect(events.map((e) => [e.turnId, e.reason])).toEqual(expected);
      prediction(detector, 2);
      expect(classifier.requests.empty).toBe(true);
    },
  );

  it('empty turn does not delay the next prediction', async () => {
    const stt = new DrainingSTT();
    const { detector, classifier } = await start({ stt, machineSilenceThreshold: 1_500 });
    const events = onPrediction(detector);
    speechStarted(detector);
    const stream = pushAudio(detector, stt);
    speechEnded(detector, 0);
    commitTurn(detector, endOfTurn(''));
    expect(events.map((e) => [e.turnId, e.reason])).toEqual([[1, AMDReason.REUSED]]);
    expect(prediction(detector, 1).reason).toBe(AMDReason.REUSED);

    await sleep(100);
    speechStarted(detector);
    const transcript = 'Please state your name and why you are calling.';
    stream.sendFinal(transcript);
    const transcriber = internals(detector).run!.stt as unknown as {
      current: { get(source: string): string };
    };
    await eventually(() => transcriber.current.get('amd') === transcript);
    speechEnded(detector, 0);
    const hooks = commitTurn(detector, endOfTurn(transcript));
    expect((await settle(classifier.request())).currentTurn.extra.turn_id).toBe(2);
    classifier.prediction(2, AMDCategory.MACHINE_SCREENING);

    await sleep(500);
    expect(events).toHaveLength(2);
    expect(replyHeldAt(detector)).toBe(true);
    await sleep(1_010);
    expect(events.map((e) => [e.turnId, e.category])).toEqual([
      [1, AMDCategory.UNCERTAIN],
      [2, AMDCategory.MACHINE_SCREENING],
    ]);
    expect(stream.flushed.isSet).toBe(false);
    expect(await settle(hooks.shouldReply(new ChatContext()))).toBe(true);
  });

  it('new inference discards stale turn waits', async () => {
    const { detector, session, classifier } = await start({ machineSilenceThreshold: 1_500 });
    const amd = internals(detector);
    speechStarted(detector);
    speechEnded(detector, 1_500);
    const first = (await commit(detector, session, classifier))!;
    classifier.prediction(1, AMDCategory.MACHINE_SCREENING);
    await settle(first.shouldReply(new ChatContext()));
    speechStarted(detector);
    speechEnded(detector, 0);
    await commit(detector, session, classifier);
    classifier.prediction(2, AMDCategory.MACHINE_SCREENING);
    await sleep(100);
    commitTurn(detector, endOfTurn(''));
    speechStarted(detector);
    speechEnded(detector, 0);
    const fourth = (await commit(detector, session, classifier))!;
    await settle(amd._shouldReply(2, new ChatContext()));
    await settle(amd._shouldReply(3, new ChatContext()));
    expect(prediction(detector, 2).reason).toBe(AMDReason.PREDICTION);
    expect(prediction(detector, 3).reason).toBe(AMDReason.REUSED);
    classifier.prediction(4, AMDCategory.MACHINE_SCREENING);
    await settle(fourth.shouldReply(new ChatContext()));
    await playbackReleased(session);
    expect(nextDeadline(detector)).toBeDefined();
    expect(Math.abs(nextDeadline(detector)! - now() - 10_000)).toBeLessThanOrEqual(10);
  });

  it('prediction listener failure cleans up a deferred release', async () => {
    const { detector, session, classifier } = await start({ machineSilenceThreshold: 1_500 });
    detector.on('amd_prediction', () => {
      throw new TypeError('listener failed');
    });
    await commit(detector, session, classifier);
    classifier.prediction(1, AMDCategory.MACHINE_SCREENING);
    expect((await execute(detector)).reason).toBe(AMDReason.INTERNAL_ERROR);
    prediction(detector, 1);
    expect(session.amd).toBeNull();
  });

  it('late machine prediction does not postpone idle timeout', async () => {
    const { detector, session, classifier, model } = await start({
      machineSilenceThreshold: 1_500,
      inferenceTimeout: 10,
      idleTimeout: 100,
    });
    const events = onPrediction(detector);
    const replies = onSpeech(session);
    await commit(detector, session, classifier, { reply: true });
    await settle(model.calls.get());
    expect(events[events.length - 1]!.reason).toBe(AMDReason.INFERENCE_TIMEOUT);
    classifier.prediction(1, AMDCategory.MACHINE_SCREENING);
    await settle(replies[0]!.waitForPlayout());
    await macrotask();
    const releaseAt = nextDeadline(detector);
    expect(releaseAt).toBeDefined();
    await sleep(200);
    expect(detector.lifecycle).toBe(AMDLifecycle.FINISHED);
    expect(events.map((e) => [e.category, e.reason])).toEqual([
      [AMDCategory.UNCERTAIN, AMDReason.INFERENCE_TIMEOUT],
    ]);
    expect((await execute(detector, 200)).reason).toBe(AMDReason.IDLE_TIMEOUT);
  });

  it.each([null, 700])('eot without speech edges uses available timing (%s)', async (elapsed) => {
    const { detector, session, classifier } = await start({ machineSilenceThreshold: 1_500 });
    const info = endOfTurn();
    info.endOfUtteranceDelay = elapsed ?? undefined;
    commitTurn(detector, info);
    await settle(classifier.request());
    classifier.prediction(1, AMDCategory.MACHINE_SCREENING);
    const started = now();
    await settle(internals(detector)._shouldReply(1, new ChatContext()));
    expect(now()).toBe(started);
    await playbackReleased(session);
    const waited = now() - started;
    expect(Math.abs(waited - (1_500 - (elapsed ?? 0)))).toBeLessThanOrEqual(10);
    expect(prediction(detector, 1).delay).toBeLessThan(10);
  });

  it('eot before speech end waits for the speech end anchor', async () => {
    const { detector, session, classifier } = await start({ machineSilenceThreshold: 1_500 });
    speechStarted(detector);
    await commit(detector, session, classifier);
    classifier.prediction(1, AMDCategory.MACHINE_SCREENING);
    await sleep(600);
    prediction(detector, 1);
    expect(replyHeldAt(detector)).toBe(true);
    speechEnded(detector, 500);
    const started = now();
    await settle(internals(detector)._shouldReply(1, new ChatContext()));
    await playbackReleased(session);
    expect(Math.abs(now() - started - 1_000)).toBeLessThanOrEqual(10);
    expect(prediction(detector, 1).delay).toBeLessThan(10);
  });

  it.each([
    [700, 800],
    [null, 1_500],
    [-500, 1_500],
  ])(
    'speech timing is independent of event creation (delay %s)',
    async (speechDelay, remainingSilence) => {
      const { detector, session, classifier } = await start({ machineSilenceThreshold: 1_500 });
      const stamp = (at: number) => (speechDelay !== null ? at - speechDelay : undefined);
      let at = Date.now();
      state(detector).onUserStateChanged(
        createUserStateChangedEvent('listening', 'speaking', at - 200, stamp(at)),
      );
      await sleep(1_000);
      at = Date.now();
      state(detector).onUserStateChanged(
        createUserStateChangedEvent('speaking', 'listening', at - 200, stamp(at)),
      );
      await commit(detector, session, classifier);
      classifier.prediction(1, AMDCategory.MACHINE_SCREENING);
      const started = now();
      await settle(internals(detector)._shouldReply(1, new ChatContext()));
      await playbackReleased(session);
      expect(Math.abs(prediction(detector, 1).speechDuration - 1_000)).toBeLessThanOrEqual(10);
      expect(Math.abs(now() - started - remainingSilence)).toBeLessThanOrEqual(10);
      expect(prediction(detector, 1).delay).toBeLessThan(10);
    },
  );

  it.each(['vad', 'stt', 'stt_with_vad'])(
    'audio recognition supplies speech edges and elapsed silence (%s)',
    async (source) => {
      const vad = source === 'stt' ? undefined : new ScriptedVAD();
      const { detector, session } = await start({
        machineSilenceThreshold: 1_500,
        sessionOptions: { vad },
      });
      const recognition = recognitionOf(session);
      recognition.runEOUDetection = vi.fn();
      const stateEvents: UserStateChangedEvent[] = [];
      session.on(AgentSessionEventTypes.UserStateChanged, (event) => stateEvents.push(event));
      if (source === 'vad') {
        await vad!.inject(vadEvent(VADEventType.START_OF_SPEECH, { speechDuration: 100 }));
      } else {
        recognition.turnDetectionMode = 'stt';
        await recognition.onSTTEvent({ type: SpeechEventType.START_OF_SPEECH });
      }
      expect(state(detector).speechStartedAt).toBeDefined();
      expect(state(detector).speechSinceCommit).toBe(true);
      const last = () => stateEvents[stateEvents.length - 1]!;
      // JS SpeechEvent has no speechStartTime yet (a Python main feature that predates
      // #6202), so an STT start is stamped at arrival rather than backdated 100 ms
      const startOffset = source === 'vad' ? 100 : 0;
      expect(Math.abs(last().speechTimestamp! - (Date.now() - startOffset))).toBeLessThanOrEqual(
        10,
      );
      await sleep(1_000);
      if (source === 'vad') {
        await vad!.inject(
          vadEvent(VADEventType.END_OF_SPEECH, {
            speechDuration: 300,
            silenceDuration: 500,
            inferenceDuration: 200,
          }),
        );
      } else {
        await recognition.onSTTEvent({
          type: SpeechEventType.END_OF_SPEECH,
          speechEndTime: Date.now() - 700,
        });
      }
      expect(state(detector).speechStartedAt).toBeUndefined();
      expect(Math.abs(state(detector).speechEndedAt! - (now() - 700))).toBeLessThanOrEqual(10);
      expect(Math.abs(last().speechTimestamp! - (Date.now() - 700))).toBeLessThanOrEqual(10);
      expect(Math.abs(last().createdAt - Date.now())).toBeLessThanOrEqual(10);
      if (source === 'stt_with_vad') {
        const speechEndedAt = state(detector).speechEndedAt;
        await vad!.inject(
          vadEvent(VADEventType.END_OF_SPEECH, { speechDuration: 300, silenceDuration: 100 }),
        );
        expect(stateEvents).toHaveLength(2);
        expect(state(detector).speechEndedAt).toBe(speechEndedAt);
        await vad!.inject(vadEvent(VADEventType.START_OF_SPEECH, { speechDuration: 100 }));
        expect(state(detector).speechStartedAt).toBeDefined();
        expect(state(detector).speechSinceCommit).toBe(true);
      }
    },
  );

  it.each(['vad', 'stt'])('untranscribed speech restarts idle timer (%s)', async (source) => {
    useVirtualTime();
    const vad = source === 'vad' ? new ScriptedVAD() : undefined;
    const session = await sessionWith(
      {
        llm: new FakeLLM(),
        stt: new FakeSTT(),
        vad,
        turnHandling: { turnDetection: source === 'vad' ? 'vad' : 'stt' },
      },
      new Agent({ instructions: 'Answer the call.' }),
    );
    const detector = new AMD(session, { llm: null, stt: null, idleTimeout: 200, timeout: 2_000 });
    closeAtEnd(detector, session);
    await detector.start();
    await eventually(() => detector.lifecycle === AMDLifecycle.ACTIVE);
    const recognition = recognitionOf(session);
    if (vad) {
      await vad.inject(vadEvent(VADEventType.START_OF_SPEECH));
    } else {
      await recognition.onSTTEvent({ type: SpeechEventType.START_OF_SPEECH });
    }
    await sleep(300);
    expect(detector.lifecycle).toBe(AMDLifecycle.ACTIVE);

    if (vad) {
      await vad.inject(vadEvent(VADEventType.END_OF_SPEECH, { speechDuration: 300 }));
    } else {
      await recognition.onSTTEvent({ type: SpeechEventType.END_OF_SPEECH });
    }
    await sleep(100);
    expect(detector.lifecycle).toBe(AMDLifecycle.ACTIVE);
    const result = await execute(detector, 200);
    expect(result.reason).toBe(AMDReason.IDLE_TIMEOUT);
    expect(result.lastPrediction).toBeNull();
  });

  it('speech end does not start idle while customer hook runs', async () => {
    const agent = new CustomerAgent({ stop: true });
    agent.hookRelease.clear();
    const { detector, session, classifier } = await start({ agent, idleTimeout: 100 });
    await commit(detector, session, classifier, { reply: true });
    await settle(agent.hookStarted.wait());
    classifier.prediction(1, AMDCategory.MACHINE_SCREENING);
    await settle(internals(detector)._shouldReply(1, new ChatContext()));
    speechStarted(detector);
    speechEnded(detector, 0);
    await sleep(200);
    expect(detector.lifecycle).toBe(AMDLifecycle.ACTIVE);

    agent.hookRelease.set();
    const result = await execute(detector, 200);
    expect(result.reason).toBe(AMDReason.IDLE_TIMEOUT);
  });

  it.each(['timeout', 'cancelled', 'participant_disconnected'])(
    'completion cancels silence wait and releases the held reply (%s)',
    async (reason) => {
      const { detector, session, classifier } = await start({
        machineSilenceThreshold: 1_500,
        inferenceTimeout: 200,
        timeout: 500,
      });
      const amd = internals(detector);
      const events = onPrediction(detector);
      await commit(detector, session, classifier);
      const committedAt = now();
      classifier.prediction(1, AMDCategory.MACHINE_VM);
      await eventually(() => {
        const at = nextDeadline(detector);
        return at !== undefined && at > committedAt + 400;
      });
      expect((await settle(amd._shouldReply(1, new ChatContext()))).allow).toBe(true);
      expect(playbackAllowed(session)).toBe(false);
      if (reason === 'cancelled') {
        await settle(detector.aclose());
      } else if (reason === 'participant_disconnected') {
        state(detector).participantIdentity = 'callee';
        state(detector).onDisconnected({ identity: 'callee' });
      }
      expect((await execute(detector)).reason).toBe(reason);
      expect(playbackAllowed(session)).toBe(true);
      expect(nextDeadline(detector)).toBeUndefined();
      await sleep(1_600);
      expect(prediction(detector, 1).category).toBe(AMDCategory.MACHINE_VM);
      expect(events.map((e) => e.category)).toEqual([AMDCategory.MACHINE_VM]);
      expect(replyHeldAt(detector)).toBe(false);
      expect(session.amd).toBeNull();
      expect(amd.tasks.size).toBe(0);
    },
  );

  it('silence deadline crossed while rearming still wakes reply', async () => {
    const { detector, session, classifier } = await start({ machineSilenceThreshold: 1_500 });
    const hooks = (await commit(detector, session, classifier))!;
    classifier.prediction(1, AMDCategory.MACHINE_SCREENING);
    await eventually(() => internals(detector).turns.get(1)!.prediction !== null);
    expect(await settle(hooks.shouldReply(new ChatContext()))).toBe(true);
    expect(playbackAllowed(session)).toBe(false);
    const releaseAt = state(detector).speechEndedAt! + 1_500;
    const clock = vi
      .spyOn(performance, 'now')
      .mockReturnValueOnce(releaseAt - 10)
      .mockReturnValueOnce(releaseAt - 10)
      .mockReturnValue(releaseAt + 10);
    const timers = vi.spyOn(globalThis, 'setTimeout');
    try {
      internals(detector)._updateIdle();
      // the rearmed timer is due now, though the deadline was ahead when it was computed
      expect(timers.mock.calls[timers.mock.calls.length - 1]![1]).toBe(0);
      await playbackReleased(session, 100);
    } finally {
      timers.mockRestore();
      clock.mockRestore();
    }
    expect(detector.lifecycle).toBe(AMDLifecycle.ACTIVE);
  });

  it('machine reply generates during the hold and plays after it', async () => {
    const toolRanAt: number[] = [];

    class ToolAgent extends Agent {
      constructor() {
        super({
          instructions: 'You are calling about an appointment.',
          tools: {
            note_screening: tool({
              description: 'Record that the screener asked a question.',
              execute: async () => {
                toolRanAt.push(now());
              },
            }),
          },
        });
      }

      override async onUserTurnCompleted(turnCtx: ChatContext): Promise<void> {
        turnCtx.addMessage({ role: 'system', content: 'Customer hook edit' });
      }
    }

    const { detector, session, classifier, model } = await start({
      agent: new ToolAgent(),
      machineSilenceThreshold: 1_500,
    });
    model.lookup(DEFAULT_SCREENING_INSTRUCTIONS)!.toolCalls = [
      { name: 'note_screening', args: {} },
    ];
    const speakingAt: number[] = [];
    session.on(AgentSessionEventTypes.AgentStateChanged, (event) => {
      if (event.newState === 'speaking') {
        speakingAt.push(now());
      }
    });
    speechStarted(detector);
    speechEnded(detector, 500);
    await commit(detector, session, classifier, { reply: true });
    const releaseAt = state(detector).speechEndedAt! + 1_500;
    classifier.prediction(1, AMDCategory.MACHINE_SCREENING);
    const call = await settle(model.calls.get());
    expect(now()).toBeLessThan(releaseAt - 900);
    const items = call.chatCtx.items;
    expect((items[items.length - 1] as ChatMessage).textContent).toBe(
      DEFAULT_SCREENING_INSTRUCTIONS,
    );

    await sleep(releaseAt - now() - 10);
    expect(playbackAllowed(session)).toBe(false);
    expect(speakingAt).toEqual([]);
    expect(toolRanAt).toEqual([]);
    await eventually(() => speakingAt.length > 0 && toolRanAt.length > 0);
    expect(speakingAt[0]!).toBeGreaterThanOrEqual(releaseAt);
    expect(toolRanAt[0]!).toBeGreaterThanOrEqual(releaseAt);
  });

  it('resumed speech extends the hold for a generated reply', async () => {
    const { detector, session, classifier, model } = await start({
      machineSilenceThreshold: 1_500,
    });
    const speeches = onSpeech(session);
    speechStarted(detector);
    speechEnded(detector, 500);
    await commit(detector, session, classifier, { reply: true });
    classifier.prediction(1, AMDCategory.MACHINE_SCREENING);
    await settle(model.calls.get());
    await sleep(500);
    speechStarted(detector);
    await sleep(2_000);
    expect(playbackAllowed(session)).toBe(false);
    expect(session.agentState).not.toBe('speaking');

    speechEnded(detector, 0);
    const releaseAt = now() + 1_500;
    await sleep(1_490);
    expect(playbackAllowed(session)).toBe(false);
    expect(session.agentState).not.toBe('speaking');
    await playbackReleased(session);
    expect(Math.abs(now() - releaseAt)).toBeLessThanOrEqual(10);
    expect(speeches).toHaveLength(1);
    await settle(speeches[0]!.waitForPlayout());
    expect(speeches[0]!.interrupted).toBe(false);
    expect(session.output.audio!.capturedPlayoutSegments).toBe(1);
  });

  it.each([AMDCategory.MACHINE_SCREENING, AMDCategory.HUMAN, AMDCategory.MACHINE_UNAVAILABLE])(
    'newer turn cancels a held reply (%s)',
    async (category) => {
      const { detector, session, classifier, model } = await start({
        machineSilenceThreshold: 1_500,
      });
      const speeches = onSpeech(session);
      speechStarted(detector);
      speechEnded(detector, 500);
      await commit(detector, session, classifier, { reply: true });
      classifier.prediction(1, AMDCategory.MACHINE_SCREENING);
      await settle(model.calls.get());
      expect(speeches).toHaveLength(1);
      const held = speeches[0]!;

      speechStarted(detector);
      speechEnded(detector, 1_500);
      await commit(detector, session, classifier, { reply: true });
      await settle(held.waitForPlayout());
      expect(held.interrupted).toBe(true);
      classifier.prediction(2, category);
      await settle(activityOf(session)._userTurnCompletedTask!.result);

      if (category === AMDCategory.MACHINE_UNAVAILABLE) {
        expect((await execute(detector)).category).toBe(category);
        expect(speeches).toHaveLength(1);
      } else {
        expect(speeches).toHaveLength(2);
        await settle(speeches[1]!.waitForPlayout());
        expect(speeches[1]!.interrupted).toBe(false);
      }
      expect(session.output.audio!.capturedPlayoutSegments).toBe(
        category === AMDCategory.MACHINE_UNAVAILABLE ? 0 : 1,
      );
    },
  );

  it('newer turn without a reply cancels a held reply', async () => {
    const { detector, session, classifier, model } = await start({
      machineSilenceThreshold: 1_500,
    });
    const activity = activityOf(session);
    const speeches = onSpeech(session);
    speechStarted(detector);
    speechEnded(detector, 500);
    await commit(detector, session, classifier, { reply: true });
    classifier.prediction(1, AMDCategory.MACHINE_SCREENING);
    await settle(model.calls.get());
    expect(speeches).toHaveLength(1);

    expect(await activity.onEndOfTurn(endOfTurn('hello', { skipReply: true }))).toBe(true);
    await settle(speeches[0]!.waitForPlayout());
    expect(speeches[0]!.interrupted).toBe(true);
    expect(session.output.audio!.capturedPlayoutSegments).toBe(0);
  });

  it('superseded held voicemail does not consume the stage message', async () => {
    const { detector, session, classifier, model } = await start({
      machineSilenceThreshold: 1_500,
    });
    const amd = internals(detector);
    const speeches = onSpeech(session);
    speechStarted(detector);
    speechEnded(detector, 500);
    await commit(detector, session, classifier, { reply: true });
    classifier.prediction(1, AMDCategory.MACHINE_VM);
    await settle(model.calls.get());
    expect(amd.voicemailHandle).toBe(speeches[0]);

    speechStarted(detector);
    speechEnded(detector, 1_500);
    await commit(detector, session, classifier, { reply: true });
    await settle(speeches[0]!.waitForPlayout());
    expect(speeches[0]!.interrupted).toBe(true);
    expect(amd.voicemailHandle).toBeUndefined();
    expect(amd.voicemailMessagePlayed).toBe(false);

    classifier.prediction(2, AMDCategory.MACHINE_VM);
    await settle(activityOf(session)._userTurnCompletedTask!.result);
    expect(amd.voicemailHandle).toBe(speeches[1]);
    await settle(speeches[1]!.waitForPlayout());
    expect(amd.voicemailMessagePlayed).toBe(true);
    expect(session.output.audio!.capturedPlayoutSegments).toBe(1);
  });
});
