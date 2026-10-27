// SPDX-FileCopyrightText: 2026 LiveKit, Inc.
//
// SPDX-License-Identifier: Apache-2.0

/**
 * Ported from Python `tests/test_amd_detector.py`, from
 * `test_classifier_sees_both_transcripts_without_changing_agent_transcript` to the end.
 */
import { AudioFrame } from '@livekit/rtc-node';
import { inspect } from 'node:util';
import { afterEach, describe, expect, it, onTestFinished, vi } from 'vitest';
import { APIConnectionError } from '../../_exceptions.js';
import { ChatContext, ChatMessage, FunctionCall } from '../../llm/chat_context.js';
import { LLMStream } from '../../llm/llm.js';
import type { ToolChoice, ToolContextLike } from '../../llm/tool_context.js';
import { log } from '../../log.js';
import { FakeSTT } from '../../stt/testing/fake_stt.js';
import { type APIConnectOptions, DEFAULT_API_CONNECT_OPTIONS } from '../../types.js';
import { Future, Task } from '../../utils.js';
import type { AgentActivity } from '../agent_activity.js';
import { SpeechHandle } from '../speech_handle.js';
import type { TurnHooks } from '../turn_hooks.js';
import {
  ClassifierLLM,
  DrainingSTT,
  commit,
  commitTurn,
  dtmfCalls,
  dtmfExecuted,
  endOfTurn,
  eventually,
  internals,
  nextDeadline,
  pushAudio,
  running,
  speechStarted,
  transcribe,
  waitFor,
} from './amd_test_utils.js';
import type { AMDRequest } from './chat_context.js';
import { DEFAULT_HUMAN_INSTRUCTIONS, DEFAULT_VOICEMAIL_INSTRUCTIONS } from './detector.js';
import type { AMD } from './detector.js';
import { AMDCategory, AMDLifecycle, type AMDMenuObservedEvent, AMDReason } from './events.js';
import type { AMDPredictionEvent } from './events.js';
import { RECOMMENDED } from './fsm.js';
import type * as FsmModule from './fsm.js';
import { CLASSIFY_PROMPT } from './inference.js';
import type * as InferenceModule from './inference.js';

type AnyFn = (...args: never[]) => unknown;

// Python monkeypatches `_inference.classify`, `_inference.extract_ivr_menu`, and
// `_fsm.transition`. ESM exports are read-only, so the modules forward to per-test overrides.
const overrides = vi.hoisted(() => ({
  classify: undefined as AnyFn | undefined,
  extractIvrMenu: undefined as AnyFn | undefined,
  transition: undefined as AnyFn | undefined,
  actualTransition: undefined as AnyFn | undefined,
}));

vi.mock('./inference.js', async (importOriginal) => {
  const mod = await importOriginal<typeof InferenceModule>();
  return {
    ...mod,
    classify: (...args: Parameters<typeof mod.classify>) =>
      ((overrides.classify as typeof mod.classify | undefined) ?? mod.classify)(...args),
    extractIvrMenu: (...args: Parameters<typeof mod.extractIvrMenu>) =>
      ((overrides.extractIvrMenu as typeof mod.extractIvrMenu | undefined) ?? mod.extractIvrMenu)(
        ...args,
      ),
  };
});

vi.mock('./fsm.js', async (importOriginal) => {
  const mod = await importOriginal<typeof FsmModule>();
  overrides.actualTransition = mod.transition as AnyFn;
  return {
    ...mod,
    transition: (...args: Parameters<typeof mod.transition>) =>
      ((overrides.transition as typeof mod.transition | undefined) ?? mod.transition)(...args),
  };
});

afterEach(() => {
  overrides.classify = undefined;
  overrides.extractIvrMenu = undefined;
  overrides.transition = undefined;
  vi.restoreAllMocks();
});

/** Wrap the real `fsm.transition` in a spy, like Python's `Mock(wraps=_fsm.transition)`. */
function spyOnTransition() {
  const transition = vi.fn(overrides.actualTransition as typeof FsmModule.transition);
  overrides.transition = transition as AnyFn;
  return transition;
}

/** Private detector members the Python tests call directly. */
interface DetectorPrivates {
  replyHeldAt(now: number): boolean;
  finish(reason: AMDReason): void;
  extractMenu(turnId: number, transcript: string, signal: AbortSignal): Promise<void>;
  menuTask: Task<void> | undefined;
  classifierTask: Task<void> | undefined;
  logger: unknown;
  run: { stt: { current: { get(source: 'session' | 'amd'): string } } };
}

function privates(detector: AMD): DetectorPrivates {
  return detector as unknown as DetectorPrivates;
}

function noPendingSpeech(activity: AgentActivity): boolean {
  const queue = (activity as unknown as { speechQueue: { size(): number } }).speechQueue;
  const current = activity.currentSpeech;
  return queue.size() === 0 && (current === undefined || current.done());
}

function messages(chatCtx: ChatContext): ChatMessage[] {
  return chatCtx.items.filter((item): item is ChatMessage => item instanceof ChatMessage);
}

function track<T>(promise: Promise<T>): { done: boolean; promise: Promise<T> } {
  const tracked = { done: false, promise };
  promise.then(
    () => (tracked.done = true),
    () => (tracked.done = true),
  );
  return tracked;
}

async function tick(): Promise<void> {
  await new Promise((resolve) => setImmediate(resolve));
}

async function sleep(ms: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

/** Record every stream the classifier opens, to see whether AMD cancelled its request. */
function captureStreams(classifier: ClassifierLLM): LLMStream[] {
  const streams: LLMStream[] = [];
  const chat = classifier.chat.bind(classifier);
  vi.spyOn(classifier, 'chat').mockImplementation((options) => {
    const stream = chat(options);
    streams.push(stream);
    return stream;
  });
  return streams;
}

function streamCancelled(stream: LLMStream): boolean {
  return (stream as unknown as { abortController: AbortController }).abortController.signal.aborted;
}

function useFakeTimers(): void {
  vi.useFakeTimers({
    toFake: ['setTimeout', 'clearTimeout', 'performance', 'Date'],
    shouldAdvanceTime: true,
  });
  onTestFinished(() => {
    vi.useRealTimers();
  });
}

function addReplyResponse(model: unknown, input: string, content: string): void {
  (model as { responseMap: Map<string, unknown> }).responseMap.set(input, {
    type: 'llm',
    input,
    content,
    ttft: 0,
    duration: 0,
  });
}

class RetryStream extends LLMStream {
  constructor(
    private readonly owner: RetryingClassifierLLM,
    params: {
      chatCtx: ChatContext;
      toolCtx?: ToolContextLike;
      connOptions: APIConnectOptions;
    },
    private readonly response: Future<string>,
  ) {
    super(owner, { ...params, toolCtx: params.toolCtx as never });
  }

  protected async run(): Promise<void> {
    this.owner.attempts += 1;
    if (this.owner.attempts <= this.owner.failures) {
      throw new APIConnectionError({
        message: 'provider failure',
        options: { retryable: this.owner.retryable },
      });
    }
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

/**
 * A classifier whose provider fails the first `failures` attempts. Python patches
 * `ControlledStream._run`; the shared stream forces `maxRetry: 0`, so this one keeps the
 * session's connection options.
 */
class RetryingClassifierLLM extends ClassifierLLM {
  attempts = 0;
  readonly connOptionsSeen: APIConnectOptions[] = [];

  constructor(
    readonly failures: number,
    readonly retryable = true,
  ) {
    super();
  }

  override chat({
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
  }): LLMStream {
    this.connOptionsSeen.push(connOptions);
    const response = new Future<string>();
    const first = chatCtx.items[0];
    if (first instanceof ChatMessage && first.textContent === CLASSIFY_PROMPT) {
      const data = JSON.parse((chatCtx.items[1] as ChatMessage).textContent ?? '{}');
      const users = messages(chatCtx).filter((m) => m.role === 'user');
      const current = users[users.length - 1]!;
      this.responses.set(current.extra.turn_id as number, response);
      this.requests.put({
        ...data,
        currentTurn: current,
        earlierTurns: users.slice(0, -1),
        chatCtx: chatCtx.copy(),
        toolCtx,
        toolChoice,
        parallelToolCalls,
        connOptions,
      });
    } else {
      this.menuRequests.put(response);
    }
    return new RetryStream(this, { chatCtx, toolCtx, connOptions }, response);
  }
}

describe('AMD detector context, inference, and wait', () => {
  it.each([false, true])(
    'classifier sees both transcripts without changing agent transcript (session STT: %s)',
    async (sessionStt) => {
      const stt = new DrainingSTT();
      const { detector, session, classifier, model } = await running({
        stt,
        sessionOptions: { stt: sessionStt ? new FakeSTT() : undefined },
      });
      addReplyResponse(model, 'session transcript', 'Hello.');
      const stream = pushAudio(detector, stt);
      transcribe(detector, 'session transcript');
      stream.sendFinal('AMD transcript');
      await eventually(() => privates(detector).run.stt.current.get('amd') === 'AMD transcript');

      const info = endOfTurn('session transcript');
      const activity = session._activity!;
      void activity.onEndOfTurn(info);
      const request = await classifier.request();
      expect(request.currentTurn.textContent).toBe(
        sessionStt
          ? '{"transcript_1": "session transcript", "transcript_2": "AMD transcript"}'
          : 'AMD transcript',
      );
      expect(stream.flushed.isSet).toBe(false);
      classifier.prediction(1, AMDCategory.UNCERTAIN);
      const reply = await model.calls.get();
      const contents = messages(reply.chatCtx).map((m) => m.textContent);
      expect(contents).toContain('session transcript');
      expect(contents.some((text) => (text ?? '').includes('AMD transcript'))).toBe(false);
      expect(info.newTranscript).toBe('session transcript');
      await activity._userTurnCompletedTask!.result;
      await eventually(() => noPendingSpeech(activity));
      expect(
        messages(session.currentAgent.chatCtx).some((m) => m.textContent === 'session transcript'),
      ).toBe(true);
    },
  );

  it('a late AMD transcript does not empty the turn', async () => {
    // the session committed the turn before AMD's STT delivered its words
    const stt = new DrainingSTT();
    const { detector, classifier } = await running({
      stt,
      sessionOptions: { stt: new FakeSTT() },
    });
    const stream = pushAudio(detector, stt);
    stream.sendFinal("Hi, you've reached Sam.");
    await eventually(
      () => privates(detector).run.stt.current.get('amd') === "Hi, you've reached Sam.",
    );
    commitTurn(detector, endOfTurn("Hi, you've reached Sam."));
    const first = await classifier.request();
    classifier.prediction(1, AMDCategory.UNCERTAIN);

    commitTurn(detector, endOfTurn('Leave your name and number.'));
    const second = await classifier.request();
    expect(second.currentTurn.extra.turn_id).toBe(2);
    expect(second.currentTurn.textContent).toBe(
      '{"transcript_1": "Leave your name and number.", "transcript_2": ""}',
    );
    expect(second.earlierTurns).toEqual([first.currentTurn]);
  });

  it('transcript received after EOT is kept in next request', async () => {
    const stt = new DrainingSTT();
    const { detector, classifier } = await running({ stt });
    const amd = internals(detector);
    const stream = pushAudio(detector, stt);
    commitTurn(detector, endOfTurn(''));
    expect(amd.turns.get(1)!.prediction!.transcript).toBe('');
    stream.sendFinal('Please state your name.');
    await eventually(
      () => privates(detector).run.stt.current.get('amd') === 'Please state your name.',
    );
    expect(classifier.requests.empty).toBe(true);
    expect(amd.turns.get(1)!.prediction!.transcript).toBe('');

    commitTurn(detector, endOfTurn(''));
    const first = await classifier.request();
    expect(first.currentTurn.extra.turn_id).toBe(2);
    classifier.prediction(2, AMDCategory.MACHINE_SCREENING);
    await waitFor(amd._shouldReply(2, new ChatContext()));
    const prediction = amd.turns.get(2)!.prediction!;
    expect(prediction.transcript).toBe(first.currentTurn.textContent);
    expect(prediction.transcript).toBe('Please state your name.');

    stream.sendFinal('Okay, connecting you.');
    await eventually(
      () => privates(detector).run.stt.current.get('amd') === 'Okay, connecting you.',
    );
    commitTurn(detector, endOfTurn('Okay.'));
    const second = await classifier.request();
    expect(second.currentTurn.extra.turn_id).toBe(3);
    expect(second.currentTurn.textContent).toBe('Okay, connecting you.');
    expect(second.earlierTurns).toEqual([first.currentTurn]);
  });

  it('late final after many empty turns is committed at the next EOT', async () => {
    const stt = new DrainingSTT();
    const { detector, session, classifier } = await running({ stt });
    const amd = internals(detector);
    const stream = pushAudio(detector, stt);
    dtmfExecuted(session, '1');
    commitTurn(detector, endOfTurn(''));
    for (let i = 0; i < 20; i++) {
      commitTurn(detector, endOfTurn(''));
    }
    expect(amd._turnId).toBe(21);
    for (let turnId = 1; turnId <= 21; turnId++) {
      expect(amd.turns.get(turnId)!.prediction).not.toBeNull();
    }
    stream.sendFinal('Hello, can you hear me?');
    await eventually(
      () => privates(detector).run.stt.current.get('amd') === 'Hello, can you hear me?',
    );
    expect(classifier.requests.empty).toBe(true);
    commitTurn(detector, endOfTurn(''));
    const request = await classifier.request();
    expect(request.currentTurn.extra.turn_id).toBe(22);
    expect(request.currentTurn.textContent).toBe('Hello, can you hear me?');
    expect(dtmfCalls(request.chatCtx).map((call) => JSON.parse(call.args))).toEqual([
      { events: ['1'] },
    ]);
    expect(request.earlierTurns).toEqual([]);
    classifier.prediction(22, AMDCategory.HUMAN);
    expect((await detector.execute()).category).toBe(AMDCategory.HUMAN);
  });

  it('superseded inference keeps the classification context', async () => {
    const { detector, session, classifier } = await running();
    const amd = internals(detector);
    const streams = captureStreams(classifier);
    dtmfExecuted(session, '1');
    commitTurn(detector, endOfTurn('Hello, can you hear me?'));
    const previous = await classifier.request();
    const hooks = commitTurn(detector, endOfTurn("Yes, let's schedule that."));
    const request = await classifier.request();
    expect(request.earlierTurns).toEqual([previous.currentTurn]);
    expect(request.earlierTurns[0]!.textContent).toBe('Hello, can you hear me?');
    expect(request.earlierTurns[0]!.extra).toEqual({ turn_id: 1 });
    expect(dtmfCalls(request.chatCtx).map((call) => JSON.parse(call.args))).toEqual([
      { events: ['1'] },
    ]);
    expect(request.currentTurn.textContent).toBe("Yes, let's schedule that.");
    expect(request.stage).toBe('uncertain');
    expect(previous.stage).toBe('uncertain');
    expect(amd.turns.get(1)!.prediction).toBeNull();
    // Python: `classifier.responses[1].cancelled()`; JS cancels the provider stream instead
    expect(streamCancelled(streams[0]!)).toBe(true);
    classifier.prediction(2, AMDCategory.HUMAN);
    expect(await hooks.shouldReply(new ChatContext())).toBe(true);
    const result = await detector.execute();
    expect(result.lastPrediction).not.toBeNull();
    expect(result.lastPrediction!.transcript).toBe(request.currentTurn.textContent);
  });

  it.each(['prediction', 'inference_error', 'inference_timeout'])(
    'empty turns do not cancel or count against pending inference (%s)',
    async (reason) => {
      const { detector, session, classifier } = await running({
        inferenceTimeout: reason === 'inference_timeout' ? 100 : 10_000,
        maxUncertainTurns: 2,
      });
      const amd = internals(detector);
      const events: AMDPredictionEvent[] = [];
      detector.on('amd_prediction', (event) => events.push(event));
      const first = (await commit(detector, session, classifier))!;
      const firstWait = first.shouldReply(new ChatContext());
      await tick();
      const second = commitTurn(detector, endOfTurn(''));
      expect(await waitFor(firstWait)).toBe(false);
      const secondWait = second.shouldReply(new ChatContext());
      await tick();
      const current = commitTurn(detector, endOfTurn(''));
      expect(await waitFor(secondWait)).toBe(false);
      const currentWait = track(current.shouldReply(new ChatContext()));
      await tick();
      expect(currentWait.done).toBe(false);
      expect(amd.turns.get(1)!.prediction).toBeNull();
      expect(classifier.responses.get(1)!.done).toBe(false);
      expect(amd.turns.get(2)!.prediction).toBeNull();
      if (reason !== 'inference_timeout') {
        classifier.respond(
          1,
          reason === 'inference_error' ? 'invalid' : '{"category":"uncertain"}',
        );
      }
      expect(await waitFor(currentWait.promise)).toBe(true);
      const source = amd.turns.get(1)!.prediction!;
      for (const turnId of [2, 3]) {
        const reused = amd.turns.get(turnId)!.prediction!;
        expect(reused.turnId).toBe(turnId);
        expect(reused.reason).toBe(AMDReason.REUSED);
        expect(reused.category).toBe(source.category);
        expect(reused.stage).toBe(source.stage);
        expect(reused.transcript).toBe('');
      }
      expect(events.map((e) => [e.turnId, e.reason])).toEqual([
        [1, reason],
        [2, 'reused'],
        [3, 'reused'],
      ]);
      expect(classifier.requests.empty).toBe(true);
      const finalTurnId = reason === 'prediction' ? 4 : 5;
      for (let turnId = 4; turnId <= finalTurnId; turnId++) {
        await commit(detector, session, classifier);
        classifier.prediction(turnId, AMDCategory.UNCERTAIN);
        await waitFor(amd._shouldReply(turnId, new ChatContext()));
        expect(detector.lifecycle === AMDLifecycle.ACTIVE).toBe(turnId < finalTurnId);
      }
      const result = await waitFor(detector.execute());
      expect(result.reason).toBe(AMDReason.MAX_UNCERTAIN_TURNS);
      expect(result.lastPrediction).not.toBeNull();
      expect(result.lastPrediction!.turnId).toBe(finalTurnId);
    },
  );

  it('DTMF on an empty turn is context, not an inference trigger', async () => {
    const { detector, session, classifier } = await running();
    dtmfExecuted(session, '1');
    commitTurn(detector, endOfTurn(''));
    expect(classifier.requests.empty).toBe(true);
    commitTurn(detector, endOfTurn('Hello.'));
    const request = await classifier.request();
    expect(dtmfCalls(request.chatCtx).map((call) => JSON.parse(call.args))).toEqual([
      { events: ['1'] },
    ]);
    expect(request.earlierTurns).toEqual([]);
  });

  it('inference error falls back and uncertain keeps the stage', async () => {
    const { detector, session, classifier } = await running();
    const amd = internals(detector);
    const events: AMDPredictionEvent[] = [];
    detector.on('amd_prediction', (event) => events.push(event));
    const first = (await commit(detector, session, classifier))!;
    classifier.prediction(1, AMDCategory.MACHINE_VM);
    await first.shouldReply(new ChatContext());
    const state = amd._state;
    for (const [turnId, args, reason] of [
      [2, '{"category":"unknown"}', 'inference_error'],
      [3, '{"category":"uncertain"}', 'prediction'],
      [4, '{"category":"unknown"}', 'inference_error'],
    ] as const) {
      const hooks = (await commit(detector, session, classifier))!;
      classifier.respond(turnId, args);
      const ctx = new ChatContext();
      expect(await hooks.shouldReply(ctx)).toBe(true);
      expect(events[events.length - 1]!.reason).toBe(reason);
      expect(amd._state).toBe(state);
      expect(events[events.length - 1]!.stage).toBe(state);
      // the stage instructions still apply while the stage is kept
      expect((ctx.items[ctx.items.length - 1] as ChatMessage).textContent).toBe(
        DEFAULT_VOICEMAIL_INSTRUCTIONS,
      );
      expect(events[events.length - 1]!.category).toBe(AMDCategory.UNCERTAIN);
      if (turnId === 3) {
        expect(classifier.requests.empty).toBe(true);
      }
    }
  });

  describe.each([false, true])('LLM calls use session connection options (menu: %s)', (menu) => {
    it.each([
      [1, 1, true, true, 2],
      [2, 1, true, false, 2],
      [1, 0, true, false, 1],
      [1, 2, false, false, 1],
    ])(
      'failures %d, maxRetry %d, retryable %s, succeeds %s, attempts %d',
      async (failures, maxRetry, retryable, succeeds, expectedAttempts) => {
        const classifier = new RetryingClassifierLLM(failures, retryable);
        const { detector, session } = await running({ classifier });
        const amd = internals(detector);
        const options: APIConnectOptions = { maxRetry, retryIntervalMs: 0, timeoutMs: 250 };
        session.connOptions.llmConnOptions = options;
        if (menu) {
          const menus: AMDMenuObservedEvent[] = [];
          detector.on('amd_menu_observed', (event) => menus.push(event));
          const task = Task.from((controller) =>
            privates(detector).extractMenu(1, 'Press 1 for sales.', controller.signal),
          );
          privates(detector).menuTask = task;
          const response = await classifier.menuRequests.get();
          response.resolve('{"menu":"Sales","options":[{"label":"Sales","dtmf":"1"}]}');
          await task.result;
          expect(menus).toHaveLength(Number(succeeds));
        } else {
          const hooks = (await commit(detector, session, classifier))!;
          classifier.prediction(1, AMDCategory.MACHINE_SCREENING);
          expect(await hooks.shouldReply(new ChatContext())).toBe(true);
          const prediction = amd.turns.get(1)!.prediction!;
          expect(prediction.reason).toBe(succeeds ? 'prediction' : 'inference_error');
          expect(prediction.category).toBe(
            succeeds ? AMDCategory.MACHINE_SCREENING : AMDCategory.UNCERTAIN,
          );
        }
        expect(classifier.attempts).toBe(expectedAttempts);
        expect(classifier.connOptionsSeen).toHaveLength(1);
        expect(classifier.connOptionsSeen[0]).toBe(options);
      },
    );
  });

  it('prediction deadline does not wait for LLM retries', async () => {
    const classifier = new RetryingClassifierLLM(1);
    const { detector, session } = await running({ classifier, inferenceTimeout: 20 });
    const amd = internals(detector);
    session.connOptions.llmConnOptions = { maxRetry: 1, retryIntervalMs: 0, timeoutMs: 10_000 };
    const predictions: AMDPredictionEvent[] = [];
    detector.on('amd_prediction', (event) => predictions.push(event));
    const hooks = (await commit(detector, session, classifier))!;
    classifier.prediction(1, AMDCategory.HUMAN);
    expect(await hooks.shouldReply(new ChatContext())).toBe(true);
    const fallback = amd.turns.get(1)!.prediction!;
    expect(fallback.reason).toBe(AMDReason.INFERENCE_TIMEOUT);
    expect(classifier.attempts).toBe(1);
    await sleep(200);
    expect(detector.lifecycle).toBe(AMDLifecycle.ACTIVE);
    expect(amd._state).toBe(AMDCategory.UNCERTAIN);
    expect(classifier.attempts).toBe(1);
    expect(privates(detector).classifierTask).toBeUndefined();
    expect(predictions.map((event) => event.reason)).toEqual(['inference_timeout']);
    expect(amd.turns.get(1)!.prediction).toBe(fallback);
  });

  it.each(['classification', 'prediction', 'listener'])(
    'unexpected inference errors finish with internal error (%s)',
    async (source) => {
      class RuntimeError extends Error {
        override name = 'RuntimeError';
      }
      const ErrorType = source === 'listener' ? TypeError : RuntimeError;
      const error = new ErrorType('private customer content', {
        cause: new Error('private provider payload'),
      });
      const logger = log();
      const calls = (['error', 'warn', 'info', 'debug'] as const).map((level) => ({
        level,
        spy: vi.spyOn(logger, level),
      }));
      const { detector, session, classifier } = await running();
      if (source === 'classification') {
        overrides.classify = (async () => {
          throw error;
        }) as AnyFn;
        commitTurn(detector, endOfTurn());
      } else {
        if (source === 'prediction') {
          overrides.transition = (() => {
            throw error;
          }) as AnyFn;
        } else {
          detector.on('amd_prediction', () => {
            throw error;
          });
        }
        await commit(detector, session, classifier);
        classifier.prediction(1, AMDCategory.MACHINE_IVR);
      }
      expect((await waitFor(detector.execute())).reason).toBe(AMDReason.INTERNAL_ERROR);
      const failures = calls.find((c) => c.level === 'error')!.spy.mock.calls;
      expect(failures.length).toBeGreaterThan(0);
      for (const [fields] of failures) {
        expect(fields).not.toBeInstanceOf(Error);
        expect((fields as { errorType?: string }).errorType).toBe(error.name);
      }
      const text = calls.flatMap((c) => c.spy.mock.calls.map((args) => inspect(args))).join('\n');
      expect(text).not.toContain('private customer content');
      expect(text).not.toContain('private provider payload');
    },
  );

  it('unexpected menu error does not end detection', async () => {
    const extractMenu = vi.fn(async () => {
      throw new Error('menu bug');
    });
    overrides.extractIvrMenu = extractMenu as AnyFn;
    const { detector, session, classifier } = await running();
    const menus: AMDMenuObservedEvent[] = [];
    detector.on('amd_menu_observed', (event) => menus.push(event));
    const first = (await commit(detector, session, classifier))!;
    classifier.prediction(1, AMDCategory.MACHINE_IVR);
    expect(await first.shouldReply(new ChatContext())).toBe(true);
    await eventually(() => extractMenu.mock.calls.length === 1);
    await sleep(10);
    expect(detector.lifecycle).toBe(AMDLifecycle.ACTIVE);
    expect(menus).toEqual([]);
    await commit(detector, session, classifier);
    classifier.prediction(2, AMDCategory.HUMAN);
    const result = await waitFor(detector.execute());
    expect(result.category).toBe(AMDCategory.HUMAN);
    expect(result.reason).toBe(AMDReason.FINISHED);
  });

  it('menu listener error ends detection with internal error', async () => {
    const { detector, session, classifier } = await running();
    detector.on('amd_menu_observed', () => {
      throw new TypeError('listener bug');
    });
    const first = (await commit(detector, session, classifier))!;
    classifier.prediction(1, AMDCategory.MACHINE_IVR);
    expect(await first.shouldReply(new ChatContext())).toBe(true);
    const menuResponse = await classifier.menuRequests.get();
    menuResponse.resolve('{"menu":"Choose a department","options":[{"label":"Sales","dtmf":"1"}]}');
    const result = await waitFor(detector.execute());
    expect(result.reason).toBe(AMDReason.INTERNAL_ERROR);
    expect(result.category).toBe(AMDCategory.MACHINE_IVR);
  });

  it('slow menu does not block classification or next turn', async () => {
    const { detector, session, classifier } = await running();
    const streams = captureStreams(classifier);
    const first = (await commit(detector, session, classifier))!;
    classifier.prediction(1, AMDCategory.MACHINE_IVR);
    expect(await first.shouldReply(new ChatContext())).toBe(true);
    const menuResponse = await classifier.menuRequests.get();
    expect(menuResponse.done).toBe(false);
    const menuStream = streams[streams.length - 1]!;
    await commit(detector, session, classifier);
    // Python: `menu_response.cancelled()`; JS cancels the provider stream instead
    expect(streamCancelled(menuStream)).toBe(true);
    classifier.prediction(2, AMDCategory.HUMAN);
    expect((await detector.execute()).category).toBe(AMDCategory.HUMAN);
  });

  it('prediction listener next turn cancels the previous menu', async () => {
    const extractMenu = vi.fn(async () => ({ menu: '', options: [] }));
    overrides.extractIvrMenu = extractMenu as AnyFn;
    const { detector, session, classifier } = await running();
    detector.on('amd_prediction', (event) => {
      if (event.turnId === 1) {
        commitTurn(detector, endOfTurn('Hello, can you hear me?'));
      }
    });
    await commit(detector, session, classifier);
    classifier.prediction(1, AMDCategory.MACHINE_IVR);
    expect((await classifier.request()).currentTurn.extra.turn_id).toBe(2);
    await sleep(10);
    expect(extractMenu).not.toHaveBeenCalled();
    classifier.prediction(2, AMDCategory.HUMAN);
    expect((await waitFor(detector.execute())).category).toBe(AMDCategory.HUMAN);
  });

  it('delayed deadline cancels reply hold without repeating effects', async () => {
    const extractMenu = vi.fn(async () => ({ menu: '', options: [] }));
    overrides.extractIvrMenu = extractMenu as AnyFn;
    const { detector, session, classifier } = await running({
      machineSilenceThreshold: 1_500,
      inferenceTimeout: 200,
      timeout: 2_000,
    });
    const amd = internals(detector);
    const events: AMDPredictionEvent[] = [];
    detector.on('amd_prediction', (event) => events.push(event));
    await commit(detector, session, classifier);
    const setTimeoutSpy = vi.spyOn(globalThis, 'setTimeout');
    classifier.prediction(1, AMDCategory.MACHINE_IVR);
    await sleep(10);
    expect(amd.turns.get(1)!.prediction!.category).toBe(AMDCategory.MACHINE_IVR);
    expect(privates(detector).replyHeldAt(performance.now())).toBe(true);
    expect(extractMenu).toHaveBeenCalledOnce();
    const state = amd._state;
    const timer = amd.timer;
    expect(timer).toBeDefined();
    const index = setTimeoutSpy.mock.results.findIndex((result) => result.value === timer);
    const onDeadline = setTimeoutSpy.mock.calls[index]![0] as () => void;
    setTimeoutSpy.mockRestore();
    // fire the armed timer as if the loop ran it late
    const now = performance.now.bind(performance);
    const delayedClock = vi.spyOn(performance, 'now').mockImplementation(() => now() + 3_000);
    onDeadline();
    delayedClock.mockRestore();
    const result = await waitFor(detector.execute());
    expect(result.reason).toBe(AMDReason.TIMEOUT);
    expect(result.category).toBe(AMDCategory.MACHINE_IVR);
    expect(amd._state).toBe(state);
    expect(events).toHaveLength(1);
    expect(extractMenu).toHaveBeenCalledOnce();
  });

  it('screening prediction is forwarded to session observability', async () => {
    const { detector, session, classifier } = await running();
    const host = { _onAmdPrediction: vi.fn() };
    const withHost = session as unknown as { sessionHost: unknown };
    withHost.sessionHost = host;
    try {
      const hooks = (await commit(detector, session, classifier))!;
      classifier.prediction(1, AMDCategory.MACHINE_SCREENING);
      await hooks.shouldReply(new ChatContext());
      const forwarded = host._onAmdPrediction.mock.calls.at(-1)![0] as AMDPredictionEvent;
      expect(forwarded.category).toBe(AMDCategory.MACHINE_SCREENING);
    } finally {
      withHost.sessionHost = undefined;
    }
  });

  it('split screening rollover retains all turns', async () => {
    const { detector, classifier } = await running();
    const amd = internals(detector);
    const history: Array<[string, AMDCategory]> = [
      ['Please state your name and why you are calling.', AMDCategory.MACHINE_SCREENING],
      ['Okay.', AMDCategory.UNCERTAIN],
      ["They can't take the call.", AMDCategory.UNCERTAIN],
      ['Feel free to leave a message.', AMDCategory.MACHINE_VM],
    ];
    for (const [index, [transcript, category]] of history.entries()) {
      const turnId = index + 1;
      commitTurn(detector, endOfTurn(transcript));
      const request = await classifier.request();
      expect(request.earlierTurns.map((e) => e.textContent)).toEqual(
        history.slice(0, index).map((prior) => prior[0]),
      );
      classifier.prediction(turnId, category);
      await eventually(() => amd.turns.get(turnId)!.prediction !== null);
    }
    expect(amd._state).toBe(AMDCategory.MACHINE_VM);
    expect(amd.previousStage).toBe(AMDCategory.MACHINE_SCREENING);
    expect(amd.turns.get(3)!.prediction!.category).toBe(AMDCategory.UNCERTAIN);
    expect(amd.turns.get(3)!.prediction!.stage).toBe(AMDCategory.MACHINE_SCREENING);
  });

  describe.each(['timeout', 'new_turn', 'finish'])(
    'classifier that ignores cancellation cannot change state (cancelled by %s)',
    (cancelledBy) => {
      it.each(['human', 'wait', 'correction', 'provider_error', 'unexpected_error'])(
        'outcome %s',
        async (outcome) => {
          const requests: Array<Future<unknown>> = [];
          let cancelled = false;
          overrides.classify = (async (
            _model: unknown,
            request: AMDRequest,
            { signal }: { signal?: AbortSignal } = {},
          ) => {
            const response = new Future<unknown>();
            requests.push(response);
            const users = messages(request.chatCtx).filter((m) => m.role === 'user');
            const turnId = users[users.length - 1]!.extra.turn_id;
            const onAbort = () => {
              if (turnId !== 1) {
                response.reject(new DOMException('aborted', 'AbortError'));
                return;
              }
              cancelled = true;
            };
            signal?.addEventListener('abort', onAbort, { once: true });
            const result = await response.await;
            if (result instanceof Error) {
              throw result;
            }
            return result;
          }) as AnyFn;
          // only the timeout case needs a short deadline; Python runs on virtual time
          const { detector } = await running({
            inferenceTimeout: cancelledBy === 'timeout' ? 20 : 10_000,
          });
          const amd = internals(detector);
          const events: AMDPredictionEvent[] = [];
          detector.on('amd_prediction', (event) => events.push(event));
          commitTurn(detector, endOfTurn());
          await eventually(() => requests.length === 1);
          const response = requests[0]!;
          const oldTask = privates(detector).classifierTask!;
          let hooks: TurnHooks | undefined;
          let newerResponse: Future<unknown> | undefined;
          if (cancelledBy === 'new_turn') {
            hooks = commitTurn(detector, endOfTurn('a new prompt'));
            await eventually(() => requests.length === 2);
            newerResponse = requests[1];
          } else if (cancelledBy === 'finish') {
            privates(detector).finish(AMDReason.CANCELLED);
          }
          await eventually(() => cancelled);
          const state = amd._state;
          const predictions = [...events];
          if (outcome === 'human') {
            response.resolve({ category: AMDCategory.HUMAN });
          } else if (outcome === 'wait') {
            response.resolve({ category: AMDCategory.WAIT });
          } else if (outcome === 'correction') {
            response.resolve({ category: AMDCategory.MACHINE_SCREENING });
          } else if (outcome === 'provider_error') {
            response.resolve(new APIConnectionError({ message: 'stale provider failure' }));
          } else {
            response.resolve(new Error('stale internal failure'));
          }
          await oldTask.result.catch(() => undefined);
          await tick();
          expect(amd._state).toBe(state);
          expect(events).toEqual(predictions);
          if (cancelledBy === 'new_turn') {
            expect(amd.turns.get(1)!.prediction).toBeNull();
            newerResponse!.resolve({ category: AMDCategory.MACHINE_VM });
            expect(await hooks!.shouldReply(new ChatContext())).toBe(true);
            expect(amd._state).toBe(AMDCategory.MACHINE_VM);
          } else if (cancelledBy === 'timeout') {
            expect(amd.turns.get(1)!.prediction!.reason).toBe(AMDReason.INFERENCE_TIMEOUT);
          } else {
            expect((await detector.execute()).reason).toBe(AMDReason.CANCELLED);
          }
        },
      );
    },
  );

  it('result after deadline is ignored before timer callback', async () => {
    const { detector, session, classifier } = await running({ inferenceTimeout: 1_000 });
    const amd = internals(detector);
    const events: AMDPredictionEvent[] = [];
    detector.on('amd_prediction', (event) => events.push(event));
    const hooks = (await commit(detector, session, classifier))!;
    const task = privates(detector).classifierTask!;
    const now = performance.now.bind(performance);
    const delayedClock = vi.spyOn(performance, 'now').mockImplementation(() => now() + 2_000);
    try {
      classifier.prediction(1, AMDCategory.HUMAN);
      await task.result;
    } finally {
      delayedClock.mockRestore();
    }
    expect(await hooks.shouldReply(new ChatContext())).toBe(true);
    expect(detector.lifecycle).toBe(AMDLifecycle.ACTIVE);
    expect(amd._state).toBe(AMDCategory.UNCERTAIN);
    expect(events.map((event) => event.reason)).toEqual(['inference_timeout']);
  });

  it('prediction listener cannot mutate saved decision', async () => {
    const { detector, session, classifier } = await running();
    const amd = internals(detector);
    detector.on('amd_prediction', (event) => {
      event.category = AMDCategory.HUMAN;
      event.transcript = 'changed by listener';
    });
    const hooks = (await commit(detector, session, classifier))!;
    classifier.prediction(1, AMDCategory.MACHINE_VM);
    expect(await hooks.shouldReply(new ChatContext())).toBe(true);
    const prediction = amd.turns.get(1)!.prediction!;
    expect(prediction.category).toBe(AMDCategory.MACHINE_VM);
    expect(prediction.transcript).toBe('hello');
    expect(amd._state).toBe(AMDCategory.MACHINE_VM);
    await detector.aclose();
    const result = await detector.execute();
    expect(result.category).toBe(AMDCategory.MACHINE_VM);
    expect(result.lastPrediction).not.toBeNull();
    expect(result.lastPrediction!.transcript).toBe('hello');
  });

  it('completed AMD cannot be entered again', async () => {
    const { detector, session } = await running();
    await detector.aclose();
    const result = await detector.execute();
    await expect(detector.start()).rejects.toThrow('new AMD instance');
    expect(await detector.execute()).toBe(result);
    expect(session.amd).toBeNull();
    expect(session._turnHooks).toBeUndefined();
  });

  it('classifier history is bounded and saved decisions survive', async () => {
    const { detector, session, classifier } = await running();
    const amd = internals(detector);
    commitTurn(detector, endOfTurn('first prompt'));
    await classifier.request();
    classifier.prediction(1, AMDCategory.MACHINE_SCREENING);
    await amd._shouldReply(1, new ChatContext());
    const firstPrediction = amd.turns.get(1)!.prediction;
    for (let turnId = 2; turnId < 24; turnId++) {
      const hooks = commitTurn(detector, endOfTurn(`prompt ${turnId}`));
      await classifier.request();
      classifier.prediction(turnId, AMDCategory.MACHINE_SCREENING);
      await hooks.shouldReply(new ChatContext());
    }
    dtmfExecuted(session, '2#');
    commitTurn(detector, endOfTurn('latest prompt'));
    const request = await classifier.request();
    expect(request.currentTurn.extra.turn_id).toBe(24);
    expect(dtmfCalls(request.chatCtx).map((call) => JSON.parse(call.args))).toEqual([
      { events: ['2', '#'] },
    ]);
    expect(request.earlierTurns.map((turn) => turn.extra.turn_id)).toEqual(
      Array.from({ length: 17 }, (_, i) => i + 7),
    );
    expect(request.chatCtx.items.slice(2)).toHaveLength(20);
    expect(request.earlierTurns.every((turn) => turn.textContent)).toBe(true);
    expect(amd.turns.get(1)!.prediction).toBe(firstPrediction);
    expect(firstPrediction!.category).toBe(AMDCategory.MACHINE_SCREENING);
  });

  it('empty turns preserve transcript and DTMF history', async () => {
    const { detector, session, classifier } = await running();
    const hooks = commitTurn(detector, endOfTurn('For sales press 1.'));
    const first = await classifier.request();
    classifier.prediction(1, AMDCategory.MACHINE_IVR);
    await hooks.shouldReply(new ChatContext());
    const sent = dtmfExecuted(session, '1');
    for (let i = 0; i < 22; i++) {
      commitTurn(detector, endOfTurn(''));
    }
    expect(classifier.requests.empty).toBe(true);
    commitTurn(detector, endOfTurn('One moment please.'));
    const request = await classifier.request();
    expect(request.earlierTurns).toEqual([first.currentTurn]);
    expect(dtmfCalls(request.chatCtx)).toEqual(sent.functionCalls);
    expect(request.currentTurn.extra.turn_id).toBe(24);
  });

  it.each(['idle', 'classification', 'silence', 'speech'])(
    'AMD enforces overall deadline independently of FSM (%s)',
    async (pending) => {
      const { detector, session, classifier } = await running({
        timeout: 1_000,
        inferenceTimeout: 3_000,
        machineSilenceThreshold: 3_000,
      });
      const amd = internals(detector);
      const deadline = amd.hardDeadline;
      expect(deadline).toBeDefined();
      if (pending !== 'idle') {
        await commit(detector, session, classifier);
        if (pending !== 'classification') {
          classifier.prediction(1, AMDCategory.MACHINE_VM);
          await eventually(() => privates(detector).replyHeldAt(performance.now()));
          if (pending === 'speech') {
            speechStarted(detector);
          }
        }
      }
      const state = amd._state;
      // the stage is a plain category, not an object with its own deadline
      expect(typeof state).toBe('string');
      expect(nextDeadline(detector)).toBe(deadline);
      expect(amd.hardDeadline).toBe(deadline);
      const result = await waitFor(detector.execute(), 3_000);
      expect(result.reason).toBe(AMDReason.TIMEOUT);
      expect(result.category).toBe(
        pending === 'silence' || pending === 'speech'
          ? AMDCategory.MACHINE_VM
          : AMDCategory.UNCERTAIN,
      );
      expect(amd.hardDeadline).toBeUndefined();
      expect(amd._state).toBe(state);
      expect(privates(detector).replyHeldAt(performance.now())).toBe(false);
      expect(nextDeadline(detector)).toBeUndefined();
      expect(amd.timer).toBeUndefined();
      expect(session.amd).toBeNull();
    },
  );

  describe.each([undefined, AMDCategory.UNCERTAIN, AMDCategory.WAIT, AMDCategory.MACHINE_IVR])(
    'voicemail delivery guard survives transitions and allows retry (bridge %s)',
    (bridge) => {
      it.each(['played', 'interrupted', 'failed', 'no_audio'])('outcome %s', async (outcome) => {
        const { detector, session, classifier } = await running();
        const amd = internals(detector);
        const first = (await commit(detector, session, classifier))!;
        classifier.prediction(1, AMDCategory.MACHINE_VM);
        expect(await first.shouldReply(new ChatContext())).toBe(true);
        const handle = SpeechHandle.create();
        first.onAgentTurnCommitted(handle);
        let turnId = 1;
        if (bridge !== undefined) {
          turnId += 1;
          await commit(detector, session, classifier);
          classifier.prediction(turnId, bridge);
          await amd._shouldReply(turnId, new ChatContext());
        }
        turnId += 1;
        const overlapping = (await commit(detector, session, classifier))!;
        classifier.prediction(turnId, AMDCategory.MACHINE_VM);
        expect(await overlapping.shouldReply(new ChatContext())).toBe(false);
        const state = amd._state;
        if (outcome !== 'no_audio') {
          const output = session.output.audio!;
          await output.captureFrame(new AudioFrame(new Int16Array(24), 24_000, 1, 24));
          output.flush();
          await output.waitForPlayout();
        }
        if (outcome === 'interrupted') {
          handle.interrupt();
        }
        handle._markDone(outcome === 'failed' ? new Error('playback failed') : undefined);
        await eventually(() => amd.voicemailHandle === undefined);
        expect(amd._state).toBe(state);
        expect(amd.voicemailMessagePlayed).toBe(outcome === 'played');

        if (bridge !== undefined) {
          turnId += 1;
          await commit(detector, session, classifier);
          classifier.prediction(turnId, bridge);
          await amd._shouldReply(turnId, new ChatContext());
        }
        turnId += 1;
        const retry = (await commit(detector, session, classifier))!;
        classifier.prediction(turnId, AMDCategory.MACHINE_VM);
        expect(await retry.shouldReply(new ChatContext())).toBe(outcome !== 'played');
      });
    },
  );

  describe.each([AMDCategory.MACHINE_IVR, AMDCategory.WAIT])(
    'fallback and reuse leave FSM unchanged (%s)',
    (category) => {
      it.each(['inference_error', 'inference_timeout', 'reused'])('reason %s', async (reason) => {
        const { detector, session, classifier } = await running({ inferenceTimeout: 100 });
        const amd = internals(detector);
        const first = (await commit(detector, session, classifier))!;
        classifier.prediction(1, category);
        expect(await first.shouldReply(new ChatContext())).toBe(category !== AMDCategory.WAIT);
        const state = amd._state;
        const transition = spyOnTransition();
        let hooks: TurnHooks;
        if (reason === 'reused') {
          hooks = commitTurn(detector, endOfTurn(''));
        } else {
          hooks = (await commit(detector, session, classifier))!;
          if (reason === 'inference_error') {
            classifier.respond(2, 'invalid JSON');
          }
        }
        // only an empty turn repeats a wait; a turn without a prediction may be a person
        const allowed = category !== AMDCategory.WAIT || reason !== 'reused';
        expect(await hooks.shouldReply(new ChatContext())).toBe(allowed);
        expect(amd.turns.get(2)!.prediction!.reason).toBe(reason);
        expect(amd._state).toBe(state);
        expect(transition).not.toHaveBeenCalled();
      });
    },
  );

  it('valid prediction resets timeout budget before reply is allowed', async () => {
    useFakeTimers();
    const { detector, session, classifier } = await running({
      inferenceTimeout: 100,
      maxInferenceTimeouts: 2,
      machineSilenceThreshold: 1_500,
    });
    const amd = internals(detector);
    const first = (await commit(detector, session, classifier))!;
    expect(await first.shouldReply(new ChatContext())).toBe(true);
    expect(amd.inferenceTimeouts).toBe(1);
    await commit(detector, session, classifier);
    classifier.prediction(2, AMDCategory.MACHINE_SCREENING);
    await eventually(() => amd.turns.get(2)!.prediction !== null);
    expect(privates(detector).replyHeldAt(performance.now())).toBe(true);
    expect(amd.inferenceTimeouts).toBe(0);
    const third = (await commit(detector, session, classifier))!;
    expect(await third.shouldReply(new ChatContext())).toBe(true);
    expect(amd.inferenceTimeouts).toBe(1);
    expect(detector.lifecycle).toBe(AMDLifecycle.ACTIVE);
    const fourth = (await commit(detector, session, classifier))!;
    await fourth.shouldReply(new ChatContext());
    await vi.advanceTimersByTimeAsync(2_000);
    expect((await waitFor(detector.execute())).reason).toBe(AMDReason.INFERENCE_TIMEOUT);
  });

  it.each([AMDCategory.UNCERTAIN, AMDCategory.WAIT])(
    'human instructions remember machine history (bridge %s)',
    async (bridge) => {
      const { detector, session, classifier } = await running();
      const amd = internals(detector);
      let ctx = new ChatContext();
      const categories = [AMDCategory.MACHINE_SCREENING, bridge, AMDCategory.HUMAN];
      for (const [index, category] of categories.entries()) {
        const turnId = index + 1;
        const hooks = (await commit(detector, session, classifier))!;
        classifier.prediction(turnId, category);
        ctx = new ChatContext();
        expect(await hooks.shouldReply(ctx)).toBe(category !== AMDCategory.WAIT);
        if (category === bridge) {
          // wait blocks the reply; uncertain keeps the screening stage and its instructions
          if (bridge === AMDCategory.WAIT) {
            expect(ctx.items).toHaveLength(0);
          } else {
            expect((ctx.items[ctx.items.length - 1] as ChatMessage).extra.amd_stage).toBe(
              'machine-screening',
            );
          }
        }
      }
      expect((ctx.items[ctx.items.length - 1] as ChatMessage).textContent).toBe(
        DEFAULT_HUMAN_INSTRUCTIONS,
      );
      await detector.execute();
      expect(amd.previousStage).toBe(AMDCategory.MACHINE_SCREENING);
    },
  );

  it.each([
    undefined,
    AMDCategory.MACHINE_SCREENING,
    AMDCategory.MACHINE_VM,
    AMDCategory.MACHINE_IVR,
  ])('wait skips reply and allows a fresh prediction (stage %s)', async (stage) => {
    useFakeTimers();
    const { detector, session, classifier, model } = await running({
      machineSilenceThreshold: 1_500,
    });
    const amd = internals(detector);
    const events: AMDPredictionEvent[] = [];
    detector.on('amd_prediction', (event) => events.push(event));
    if (stage !== undefined) {
      await commit(detector, session, classifier);
      classifier.prediction(1, stage);
      await amd._shouldReply(1, new ChatContext());
    }
    const previous = amd._state;
    const previousStage = amd.previousStage;
    const predictions = [...events];
    const transition = spyOnTransition();
    const activity = session._activity!;
    void activity.onEndOfTurn(endOfTurn('While you wait, hear about our special offers.'));
    const request = await classifier.request();
    classifier.prediction(request.currentTurn.extra.turn_id as number, AMDCategory.WAIT);
    await waitFor(activity._userTurnCompletedTask!.result, 100);

    // wait blocks the reply but keeps the stage
    expect(amd._shouldWait).toBe(true);
    expect(amd._state).toBe(previous);
    expect(amd.previousStage).toBe(previousStage);
    expect(events.slice(0, -1)).toEqual(predictions);
    expect(events[events.length - 1]!.category).toBe(AMDCategory.WAIT);
    expect(events[events.length - 1]!.stage).toBe(previous);
    expect(privates(detector).replyHeldAt(performance.now())).toBe(false);
    expect(amd.voicemailTurnId).toBeUndefined();
    expect(model.calls.empty).toBe(true);
    expect(transition).toHaveBeenCalledOnce();
    expect(transition).toHaveBeenCalledWith(previous, AMDCategory.WAIT);
    await vi.advanceTimersByTimeAsync(1_600);
    expect(model.calls.empty).toBe(true);
    expect(detector.lifecycle).toBe(AMDLifecycle.ACTIVE);

    void activity.onEndOfTurn(endOfTurn());
    const following = await classifier.request();
    expect(following.stage).toBe(previous);
    expect(new Set(following.recommended_next_categories)).toEqual(
      new Set(RECOMMENDED.get(previous)),
    );
    classifier.prediction(following.currentTurn.extra.turn_id as number, AMDCategory.UNCERTAIN);
    // a kept machine stage still waits for participant silence before replying
    await waitFor(activity._userTurnCompletedTask!.result);
    expect(amd._shouldWait).toBe(false);
    expect(amd._state).toBe(previous);
    await model.calls.get();
    expect(transition).toHaveBeenCalledTimes(2);
    expect(transition).toHaveBeenLastCalledWith(previous, AMDCategory.UNCERTAIN);
  });

  it.each([false, true])(
    'empty turns preserve wait until new classification (pending: %s)',
    async (pending) => {
      const { detector, session, classifier } = await running();
      const amd = internals(detector);
      await commit(detector, session, classifier);
      classifier.prediction(1, AMDCategory.MACHINE_IVR);
      await amd._shouldReply(1, new ChatContext());
      let hooks = (await commit(detector, session, classifier))!;
      if (pending) {
        hooks = commitTurn(detector, endOfTurn(''));
      }
      classifier.prediction(2, AMDCategory.WAIT);
      expect(await waitFor(hooks.shouldReply(new ChatContext()), 100)).toBe(false);

      for (let i = 0; i < 2; i++) {
        hooks = commitTurn(detector, endOfTurn(''));
        expect(await waitFor(hooks.shouldReply(new ChatContext()), 100)).toBe(false);
        expect(amd.turns.get(amd._turnId)!.prediction!.category).toBe(AMDCategory.WAIT);
      }
      expect(amd._shouldWait).toBe(true);
      expect(amd._state).toBe(AMDCategory.MACHINE_IVR);
      expect(classifier.requests.empty).toBe(true);
      hooks = (await commit(detector, session, classifier))!;
      classifier.prediction(amd._turnId, AMDCategory.HUMAN);
      expect(await hooks.shouldReply(new ChatContext())).toBe(true);
      expect((await detector.execute()).category).toBe(AMDCategory.HUMAN);
    },
  );

  it.each([AMDReason.TIMEOUT, AMDReason.CANCELLED])(
    'wait does not block completion or allow a reply afterward (%s)',
    async (reason) => {
      const { detector, session, classifier } = await running({
        idleTimeout: 100,
        timeout: reason === AMDReason.TIMEOUT ? 100 : 10_000,
      });
      const hooks = (await commit(detector, session, classifier))!;
      classifier.prediction(1, AMDCategory.WAIT);
      expect(await hooks.shouldReply(new ChatContext())).toBe(false);
      if (reason === AMDReason.CANCELLED) {
        await detector.aclose();
      }
      expect((await waitFor(detector.execute(), 200)).reason).toBe(reason);
      expect(await hooks.shouldReply(new ChatContext())).toBe(false);
    },
  );

  it('wait pauses the idle timer until the next prediction', async () => {
    const { detector, session, classifier } = await running({ idleTimeout: 100 });
    const amd = internals(detector);
    let hooks = (await commit(detector, session, classifier))!;
    classifier.prediction(1, AMDCategory.WAIT);
    expect(await hooks.shouldReply(new ChatContext())).toBe(false);
    await sleep(300);
    expect(detector.lifecycle).toBe(AMDLifecycle.ACTIVE);
    expect(amd.idleDeadline).toBeUndefined();
    hooks = commitTurn(detector, endOfTurn(''));
    expect(await hooks.shouldReply(new ChatContext())).toBe(false);
    await sleep(300);
    expect(detector.lifecycle).toBe(AMDLifecycle.ACTIVE);

    hooks = (await commit(detector, session, classifier))!;
    classifier.prediction(3, AMDCategory.UNCERTAIN);
    expect(await hooks.shouldReply(new ChatContext())).toBe(true);
    expect(amd.idleDeadline).toBeDefined();
    expect((await waitFor(detector.execute(), 1_000)).reason).toBe(AMDReason.IDLE_TIMEOUT);
  });

  it.each(['uncertain', 'timeout'])(
    'wait resets inference timeout and uncertain turn budgets (prior %s)',
    async (prior) => {
      const { detector, session, classifier } = await running({
        inferenceTimeout: 50,
        maxInferenceTimeouts: 2,
        maxUncertainTurns: 2,
      });
      const amd = internals(detector);
      const first = (await commit(detector, session, classifier))!;
      if (prior === 'uncertain') {
        classifier.prediction(1, AMDCategory.UNCERTAIN);
      }
      expect(await first.shouldReply(new ChatContext())).toBe(true);
      expect(amd.uncertainTurns + amd.inferenceTimeouts).toBe(1);

      const hooks = (await commit(detector, session, classifier))!;
      classifier.prediction(2, AMDCategory.WAIT);
      expect(await hooks.shouldReply(new ChatContext())).toBe(false);
      expect(amd.uncertainTurns).toBe(0);
      expect(amd.inferenceTimeouts).toBe(0);
      const following = (await commit(detector, session, classifier))!;
      if (prior === 'uncertain') {
        classifier.prediction(3, AMDCategory.UNCERTAIN);
      }
      // a timeout after a wait is uncertain, so it does not block the reply
      expect(await following.shouldReply(new ChatContext())).toBe(true);
      expect(detector.lifecycle).toBe(AMDLifecycle.ACTIVE);
    },
  );
});
