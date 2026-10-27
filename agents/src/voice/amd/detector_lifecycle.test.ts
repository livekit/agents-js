// SPDX-FileCopyrightText: 2026 LiveKit, Inc.
//
// SPDX-License-Identifier: Apache-2.0

/**
 * Ported from Python `tests/test_amd_detector.py`, from
 * `test_menu_is_observability_only_and_dtmf_tool_is_temporary` through
 * `test_dtmf_tool_propagates_cancelled_publish`.
 */
import {
  AudioFrame,
  ParticipantKind,
  RemoteParticipant,
  RoomEvent,
  TrackKind,
} from '@livekit/rtc-node';
import { EventEmitter } from 'node:events';
import { describe, expect, it, onTestFinished, vi } from 'vitest';
import { ChatContext, ChatMessage } from '../../llm/chat_context.js';
import type { LLMStream } from '../../llm/llm.js';
import { handoff, tool } from '../../llm/tool_context.js';
import { FakeSTT } from '../../stt/testing/fake_stt.js';
import { SynthesizeStream, TTS } from '../../tts/tts.js';
import { type APIConnectOptions, DEFAULT_API_CONNECT_OPTIONS } from '../../types.js';
import { Event, delay } from '../../utils.js';
import { Agent } from '../agent.js';
import type { AgentActivity } from '../agent_activity.js';
import { AgentSession } from '../agent_session.js';
import {
  AgentSessionEventTypes,
  type FunctionToolsExecutedEvent,
  type SpeechCreatedEvent,
  createAgentFalseInterruptionEvent,
} from '../events.js';
import { SpeechHandle } from '../speech_handle.js';
import { FakeLLM } from '../testing/fake_llm.js';
import {
  ClassifierLLM,
  CustomerAgent,
  commit,
  commitTurn,
  dtmfCalls,
  dtmfExecuted,
  endOfTurn,
  eventually,
  internals,
  nextDeadline,
  running,
  speechEnded,
  speechStarted,
  waitFor,
} from './amd_test_utils.js';
import { AGENT_REPLY } from './chat_context.js';
import { AMD, DEFAULT_SCREENING_INSTRUCTIONS } from './detector.js';
import {
  AMDCategory,
  type AMDCompletedEvent,
  AMDLifecycle,
  type AMDMenuObservedEvent,
  type AMDPredictionEvent,
  AMDReason,
} from './events.js';
import { CLASSIFY_PROMPT } from './inference.js';

/** Long virtual-time waits run on fake timers that also follow real time. */
function useVirtualTime(): void {
  vi.useFakeTimers({
    toFake: ['setTimeout', 'clearTimeout', 'performance', 'Date'],
    shouldAdvanceTime: true,
  });
  onTestFinished(() => {
    vi.useRealTimers();
  });
}

interface ActivityInternals {
  _authorizationPaused: boolean;
  _currentSpeech: SpeechHandle | undefined;
  speechQueue: { size(): number };
  falseInterruptionPending: boolean;
}

function activityOf(session: AgentSession): AgentActivity & ActivityInternals {
  return session._activity as unknown as AgentActivity & ActivityInternals;
}

/** Python `activity._no_pending_speech`. */
function noPendingSpeech(session: AgentSession): boolean {
  const activity = activityOf(session);
  return (
    activity.speechQueue.size() === 0 &&
    (activity._currentSpeech === undefined || activity._currentSpeech.done())
  );
}

/** A classifier that remembers each turn's stream, so a test can see a cancelled request. */
class TrackingClassifier extends ClassifierLLM {
  readonly streams = new Map<number, LLMStream>();

  override chat(options: Parameters<ClassifierLLM['chat']>[0]): LLMStream {
    const before = new Map(this.responses);
    const stream = super.chat(options);
    for (const [turnId, response] of this.responses) {
      if (before.get(turnId) !== response) {
        this.streams.set(turnId, stream);
      }
    }
    return stream;
  }

  /** Python `classifier.responses[turn_id].cancelled()`: the request was closed unanswered. */
  cancelled(turnId: number): boolean {
    const stream = this.streams.get(turnId) as unknown as {
      abortController: AbortController;
    };
    return stream.abortController.signal.aborted;
  }
}

class SlowSynthesizeStream extends SynthesizeStream {
  label = 'slow-tts.stream';

  constructor(
    tts: SlowTTS,
    connOptions: APIConnectOptions,
    private readonly audioDuration: number,
    private readonly startDelay: number | undefined,
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
    if (this.startDelay !== undefined) {
      await delay(this.startDelay, { signal: this.abortSignal }).catch(() => undefined);
    }
    if (!text || this.abortSignal.aborted) {
      return;
    }
    const sampleRate = 24_000;
    const samples = Math.round((sampleRate * this.audioDuration) / 1000);
    this.queue.put({
      requestId: 'slow',
      segmentId: 'slow',
      final: true,
      frame: new AudioFrame(new Int16Array(samples), sampleRate, 1, samples),
    });
  }
}

/** Python `FakeTTS.update_options(fake_audio_duration=..., fake_timeout=...)`. */
class SlowTTS extends TTS {
  label = 'slow-tts';

  constructor(
    private readonly audioDuration: number,
    private readonly startDelay: number | undefined,
  ) {
    super(24_000, 1, { streaming: true });
  }

  synthesize(): never {
    throw new Error('streaming only');
  }

  stream(options?: { connOptions?: APIConnectOptions }): SynthesizeStream {
    return new SlowSynthesizeStream(
      this,
      options?.connOptions ?? DEFAULT_API_CONNECT_OPTIONS,
      this.audioDuration,
      this.startDelay,
    );
  }
}

interface FakePublication {
  sid: string;
  kind: TrackKind;
  subscribed: boolean;
  track: object | undefined;
}

/** A remote participant that passes `instanceof RemoteParticipant`. */
function fakeParticipant({
  kind = ParticipantKind.STANDARD,
  attributes = {},
  publications = [],
}: {
  kind?: ParticipantKind;
  attributes?: Record<string, string>;
  publications?: FakePublication[];
}): RemoteParticipant {
  const participant = Object.create(RemoteParticipant.prototype) as RemoteParticipant;
  Object.defineProperties(participant, {
    identity: { value: 'callee', writable: true },
    kind: { value: kind, writable: true },
    attributes: { value: attributes, writable: true },
    trackPublications: {
      value: new Map(publications.map((publication) => [publication.sid, publication])),
      writable: true,
    },
  });
  return participant;
}

class FakeRoom extends EventEmitter {
  isConnected = true;
  localParticipant = undefined;
  readonly remoteParticipants = new Map<string, RemoteParticipant>();
}

/** Start a manual-turn session with `room` as its room IO. */
async function sessionWithRoom(room: FakeRoom): Promise<{
  session: AgentSession;
  setParticipant: ReturnType<typeof vi.fn>;
}> {
  const session = new AgentSession({
    llm: new FakeLLM(),
    turnHandling: { turnDetection: 'manual' },
  });
  await session.start({ agent: new Agent({ instructions: 'Hello' }) });
  const setParticipant = vi.fn();
  session._roomIO = { rtcRoom: room, setParticipant } as never;
  return { session, setParticipant };
}

async function closeSessionWithRoom(session: AgentSession): Promise<void> {
  session._roomIO = undefined;
  await session.close();
}

function amdListeners(detector: AMD): Array<(...args: never[]) => void> {
  const amd = detector as unknown as Record<string, (...args: never[]) => void>;
  return [amd.onUserStateChanged!, amd.onUserInputTranscribed!];
}

describe('AMD lifecycle', () => {
  it('menu is observability only and dtmf tool is temporary', async () => {
    const { detector, session, classifier, model } = await running();
    const menus: AMDMenuObservedEvent[] = [];
    detector.on('amd_menu_observed', (event) => menus.push(event));
    const hooks = (await commit(detector, session, classifier))!;
    classifier.prediction(1, AMDCategory.MACHINE_IVR);
    const context = new ChatContext();
    expect(await hooks.shouldReply(context)).toBe(true);
    const before = session.currentAgent.toolCtx;
    const tools = hooks.onReplyGeneration(before);
    expect(tools.hasTool('send_dtmf_events')).toBe(true);
    expect(session.currentAgent.toolCtx.equals(before)).toBe(true);
    expect(before.hasTool('send_dtmf_events')).toBe(false);
    const response = await classifier.menuRequests.get();
    response.resolve(
      JSON.stringify({
        menu: 'Choose a department',
        options: [{ label: 'Billing', dtmf: '1' }],
      }),
    );
    await eventually(() => menus.length === 1);
    expect(menus[0]!.options[0]!.dtmf).toBe('1');
    expect(model.calls.empty).toBe(true);
    expect(noPendingSpeech(session)).toBe(true);
    expect(internals(detector)._state).toBe(AMDCategory.MACHINE_IVR);
  });

  it.each([AMDCategory.HUMAN, AMDCategory.MACHINE_UNAVAILABLE])(
    'terminal result completes once and releases turn hooks (%s)',
    async (category) => {
      const { detector, session, classifier } = await running();
      expect(session._turnHooks).toBeDefined();
      const events: AMDCompletedEvent[] = [];
      detector.on('amd_completed', (event) => events.push(event));
      const first = detector.execute();
      const second = detector.execute();
      const hooks = (await commit(detector, session, classifier))!;
      classifier.prediction(1, category);
      const [a, b] = await waitFor(Promise.all([first, second]));
      expect(a).toBe(b);
      expect(a.reason).toBe(AMDReason.FINISHED);
      expect(events).toHaveLength(1);
      expect(session.amd).toBeNull();
      expect(session._turnHooks).toBeUndefined();
      expect(activityOf(session)._authorizationPaused).toBe(false);
      expect(internals(detector).tasks.size).toBe(0);
      const [onUserStateChanged, onUserInputTranscribed] = amdListeners(detector);
      expect(session.listeners(AgentSessionEventTypes.UserStateChanged)).not.toContain(
        onUserStateChanged,
      );
      expect(session.listeners(AgentSessionEventTypes.UserInputTranscribed)).not.toContain(
        onUserInputTranscribed,
      );
      expect(await hooks.shouldReply(new ChatContext())).toBe(category === AMDCategory.HUMAN);
      await detector.aclose();
      expect(events).toHaveLength(1);
    },
  );

  it.each([false, true])(
    'late unavailable does not cancel reply (playback started: %s)',
    async (playbackStarted) => {
      const classifier = new TrackingClassifier();
      const { detector, session, model } = await running({
        classifier,
        inferenceTimeout: 20,
        // Python: tts.update_options(fake_audio_duration=10, fake_timeout=None or 2)
        sessionOptions: { tts: new SlowTTS(10_000, playbackStarted ? undefined : 2_000) },
      });
      await commit(detector, session, classifier);
      classifier.prediction(1, AMDCategory.MACHINE_SCREENING);
      await internals(detector)._shouldReply(1, new ChatContext());

      const activity = activityOf(session);
      await commit(detector, session, classifier, { reply: true });
      await model.calls.get();
      await eventually(() => activity._currentSpeech !== undefined);
      const speech = activity._currentSpeech!;
      if (playbackStarted) {
        await eventually(() => session.agentState === 'speaking');
      } else {
        expect(session.agentState).not.toBe('speaking');
      }

      classifier.prediction(2, AMDCategory.MACHINE_UNAVAILABLE);
      await delay(100);
      expect(classifier.cancelled(2)).toBe(true);
      expect(detector.lifecycle).toBe(AMDLifecycle.ACTIVE);
      expect(internals(detector)._state).toBe(AMDCategory.MACHINE_SCREENING);
      expect(speech.interrupted).toBe(false);
      if (playbackStarted) {
        expect(session.agentState).toBe('speaking');
      } else {
        expect(speech.done()).toBe(false);
      }
    },
  );

  it('cancelled execute waiter does not cancel detection', async () => {
    const { detector, session, classifier } = await running();
    // JS promises cannot be cancelled: an abandoned waiter stands in for a cancelled one
    const abandoned = detector.execute();
    await expect(Promise.race([abandoned, delay(0).then(() => 'abandoned')])).resolves.toBe(
      'abandoned',
    );
    await commit(detector, session, classifier);
    classifier.prediction(1, AMDCategory.HUMAN);
    expect((await waitFor(detector.execute())).category).toBe(AMDCategory.HUMAN);
  });

  it('cancelled reply waiter does not block other turns', async () => {
    const { detector, session, classifier } = await running();
    const amd = internals(detector);
    await commit(detector, session, classifier);
    // JS promises cannot be cancelled: an abandoned waiter stands in for a cancelled one
    void amd._shouldReply(1, new ChatContext());
    const surviving = amd._shouldReply(1, new ChatContext());
    await delay(0);

    await commit(detector, session, classifier);
    let currentDone = false;
    const current = amd._shouldReply(2, new ChatContext()).then((decision) => {
      currentDone = true;
      return decision;
    });
    await waitFor(surviving);
    expect(amd.turns.get(1)!.prediction).toBeNull();
    expect(currentDone).toBe(false);
    classifier.prediction(2, AMDCategory.HUMAN);
    await waitFor(current);
    expect(amd.turns.get(2)!.prediction!.category).toBe(AMDCategory.HUMAN);
  });

  it.each(['cancelled', 'participant_disconnected', 'timeout'])(
    'nonterminal finish releases a waiter without a prediction (%s)',
    async (reason) => {
      // Python uses a 0.03 s hard timeout on virtual time; real time needs room for setup
      const { detector, session, classifier } = await running({
        timeout: 300,
        inferenceTimeout: 1_000,
      });
      const amd = internals(detector);
      const events: AMDPredictionEvent[] = [];
      detector.on('amd_prediction', (event) => events.push(event));
      await commit(detector, session, classifier);
      let waiterDone = false;
      const waiter = amd._shouldReply(1, new ChatContext()).then(() => {
        waiterDone = true;
      });
      await delay(0);
      expect(waiterDone).toBe(false);
      if (reason === 'cancelled') {
        await detector.aclose();
      } else if (reason === 'participant_disconnected') {
        const raw = detector as unknown as {
          participantIdentity: string;
          onDisconnected(participant: { identity: string }): void;
        };
        raw.participantIdentity = 'callee';
        raw.onDisconnected({ identity: 'callee' });
      }
      const result = await waitFor(detector.execute());
      expect(result.reason).toBe(reason);
      expect(result.category).toBe(AMDCategory.UNCERTAIN);
      await waitFor(waiter);
      expect(amd.turns.get(1)!.prediction).toBeNull();
      expect(events).toEqual([]);
      expect(nextDeadline(detector)).toBeUndefined();
    },
  );

  it('empty turn does not cancel a pending terminal prediction', async () => {
    const { detector, session, classifier } = await running();
    await commit(detector, session, classifier);
    commitTurn(detector, endOfTurn(''));
    expect(internals(detector).turns.get(2)!.prediction).toBeNull();
    classifier.prediction(1, AMDCategory.HUMAN);
    const result = await waitFor(detector.execute());
    expect(result.lastPrediction).not.toBeNull();
    expect(result.lastPrediction!.turnId).toBe(1);
    expect(result.category).toBe(AMDCategory.HUMAN);
  });

  it('timeout rearms and late result cannot change a newer turn', async () => {
    const classifier = new TrackingClassifier();
    const { detector, session } = await running({ classifier, inferenceTimeout: 20 });
    const events: AMDPredictionEvent[] = [];
    detector.on('amd_prediction', (event) => events.push(event));
    const hooks = (await commit(detector, session, classifier))!;
    expect(await hooks.shouldReply(new ChatContext())).toBe(true);
    expect(events[events.length - 1]!.reason).toBe(AMDReason.INFERENCE_TIMEOUT);
    expect(nextDeadline(detector)).toBeDefined();
    await commit(detector, session, classifier);
    classifier.prediction(1, AMDCategory.MACHINE_VM);
    expect(classifier.cancelled(1)).toBe(true);
    expect(events.map((event) => event.reason)).toEqual([AMDReason.INFERENCE_TIMEOUT]);
    expect(internals(detector)._state).toBe(AMDCategory.UNCERTAIN);
    classifier.prediction(2, AMDCategory.MACHINE_IVR);
    await eventually(() => {
      const last = events[events.length - 1]!;
      return last.turnId === 2 && last.reason === AMDReason.PREDICTION;
    });
    expect(internals(detector)._state).toBe(AMDCategory.MACHINE_IVR);
  });

  it('stop response remains owned by session', async () => {
    const agent = new CustomerAgent({ stop: true });
    const { detector, session, classifier, model } = await running({ agent, idleTimeout: 30 });
    await commit(detector, session, classifier, { reply: true });
    classifier.prediction(1, AMDCategory.MACHINE_SCREENING);
    expect((await waitFor(detector.execute())).reason).toBe(AMDReason.IDLE_TIMEOUT);
    expect(agent.hooks).toHaveLength(1);
    expect(model.calls.empty).toBe(true);
  });

  it.each(['direct', 'inline'])(
    'agent handoff is rejected until amd finishes (%s)',
    async (handoffKind) => {
      const entered = new Event();

      class ReplacementAgent extends Agent {
        override async onEnter(): Promise<void> {
          entered.set();
        }
      }

      const replacement = new ReplacementAgent({ instructions: 'Continue the call.' });
      const { detector, session } = await running();
      const original = session.currentAgent;
      const activity = activityOf(session);
      const handOff = async () => {
        if (handoffKind === 'direct') {
          session.updateAgent(replacement);
        } else {
          await session._updateActivity(replacement, { previousActivity: 'pause' });
        }
      };
      await expect(handOff()).rejects.toThrow('handoffs are not supported while AMD is running');

      expect(session.currentAgent).toBe(original);
      expect(session._activity).toBe(activity);
      expect(activity._newTurnsBlocked).toBe(false);
      expect(entered.isSet).toBe(false);
      expect(session.amd).toBe(detector);
      expect(detector.lifecycle).toBe(AMDLifecycle.ACTIVE);

      await detector.aclose();
      session.updateAgent(replacement);
      await waitFor(entered.wait());
      expect(session.currentAgent).toBe(replacement);
    },
  );

  it.each([false, true])(
    'amd cannot enter during an agent handoff (draining: %s)',
    async (draining) => {
      const exiting = new Event();
      const releaseExit = new Event();

      class OriginalAgent extends Agent {
        override async onExit(): Promise<void> {
          exiting.set();
          await releaseExit.wait();
        }
      }

      const session = new AgentSession({ llm: new FakeLLM() });
      try {
        await session.start({ agent: new OriginalAgent({ instructions: 'Test' }) });
        const replacement = new Agent({ instructions: 'Continue the call.' });
        session.updateAgent(replacement);
        let detector: AMD;
        try {
          if (draining) {
            await waitFor(exiting.wait());
          }
          detector = new AMD(session, { llm: null, stt: null });
          await expect(detector.start()).rejects.toThrow('agent handoff to finish');
          expect(session.amd).toBeNull();
          expect(detector.lifecycle).toBe(AMDLifecycle.INITIALIZED);
        } finally {
          releaseExit.set();
          await (session as unknown as { updateActivityTask: { result: Promise<void> } })
            .updateActivityTask.result;
        }

        await detector.start();
        try {
          expect(session.currentAgent).toBe(replacement);
          expect(session.amd).toBe(detector);
        } finally {
          await detector.aclose();
        }
      } finally {
        await session.close();
      }
    },
  );

  it('tool handoff is cancelled while amd is running', async () => {
    const replacement = new Agent({ instructions: 'Continue the call.' });

    class HandoffAgent extends Agent {
      constructor() {
        super({
          instructions: 'You are calling about an appointment.',
          tools: {
            transfer: tool({
              description: 'Transfer the call to the next agent.',
              execute: async () => handoff({ agent: replacement }),
            }),
          },
        });
      }
    }

    const original = new HandoffAgent();
    const { detector, session, classifier, model } = await running({ agent: original });
    const warn = vi.spyOn((detector as unknown as { logger: { warn: () => void } }).logger, 'warn');
    (model as unknown as { responseMap: Map<string, unknown> }).responseMap.set(
      DEFAULT_SCREENING_INSTRUCTIONS,
      {
        input: DEFAULT_SCREENING_INSTRUCTIONS,
        type: 'llm',
        content: '',
        ttft: 0,
        duration: 0,
        toolCalls: [{ name: 'transfer', args: {} }],
      },
    );
    const handles: SpeechHandle[] = [];
    session.once(AgentSessionEventTypes.SpeechCreated, (event: SpeechCreatedEvent) => {
      handles.push(event.speechHandle);
    });
    const executed: FunctionToolsExecutedEvent[] = [];
    session.on(AgentSessionEventTypes.FunctionToolsExecuted, (event) => executed.push(event));
    await commit(detector, session, classifier, { reply: true });
    classifier.prediction(1, AMDCategory.MACHINE_SCREENING);
    await eventually(() => executed.length > 0);
    await waitFor(handles[0]!.waitForPlayout());

    expect(session.currentAgent).toBe(original);
    expect(session.amd).toBe(detector);
    expect(detector.lifecycle).toBe(AMDLifecycle.ACTIVE);
    expect(executed[0]!.hasAgentHandoff).toBe(false);
    expect(session.history.items).toContainEqual(executed[0]!.functionCallOutputs[0]);
    expect(warn).toHaveBeenCalledWith('agent handoff cancelled while AMD is running');

    await detector.aclose();
    // Python passes the instructions; the JS FakeLLM matches on the latest user message
    session.generateReply({ userInput: DEFAULT_SCREENING_INSTRUCTIONS });
    await eventually(() => session.currentAgent === replacement);
  });

  it('invalid model output falls back and releases the reply', async () => {
    const { detector, session, classifier } = await running();
    const hooks = (await commit(detector, session, classifier))!;
    classifier.respond(1, 'not JSON');
    expect(await hooks.shouldReply(new ChatContext())).toBe(true);
    const amd = internals(detector);
    expect(amd.turns.get(1)!.prediction!.reason).toBe(AMDReason.INFERENCE_ERROR);
    expect(amd._state).toBe(AMDCategory.UNCERTAIN);
    expect(detector.lifecycle).toBe(AMDLifecycle.ACTIVE);
    expect(nextDeadline(detector)).toBeDefined();
  });

  it('amd commits short turns during agent speech', async () => {
    const { detector, session } = await running({
      sessionOptions: {
        stt: new FakeSTT(),
        turnHandling: { turnDetection: 'stt', interruption: { minWords: 3 } },
      },
    });
    const activity = activityOf(session);
    const speech = SpeechHandle.create({ allowInterruptions: true });
    activity._currentSpeech = speech;
    // AMD classifies every turn, so the minWords filter does not drop a short one
    expect(await activity.onEndOfTurn(endOfTurn('hi'))).toBe(true);
    const amd = internals(detector);
    expect(amd._turnId).toBe(1);
    expect(amd.turns.get(1)!.transcript.transcript).toBe('hi');
    speech._markDone();
    activity._currentSpeech = undefined;
    await detector.aclose();
    // without AMD the same short turn is dropped while the agent speaks
    const speaking = SpeechHandle.create({ allowInterruptions: true });
    activity._currentSpeech = speaking;
    try {
      expect(await activity.onEndOfTurn(endOfTurn('hi'))).toBe(false);
    } finally {
      speaking._markDone();
      activity._currentSpeech = undefined;
    }
  });

  it('false interruption settlement rearms idle without a speech handle', async () => {
    // Python uses a 0.03 s idle timeout on virtual time; real time needs room for setup
    const { detector, session } = await running({ idleTimeout: 100 });
    const activity = activityOf(session);
    activity.falseInterruptionPending = true;
    session._updateAgentState('thinking');
    session._updateAgentState('listening');
    await delay(150);
    expect(detector.lifecycle).toBe(AMDLifecycle.ACTIVE);
    session.emit(
      AgentSessionEventTypes.AgentFalseInterruption,
      createAgentFalseInterruptionEvent({ resumed: false }),
    );
    activity.falseInterruptionPending = false;
    expect((await waitFor(detector.execute())).reason).toBe(AMDReason.IDLE_TIMEOUT);
  });

  it.each(['inference_error', 'reused', 'prediction'])(
    'unchanged voicemail rearms idle without another reply (%s)',
    async (reason) => {
      const { detector, session, classifier } = await running({ voicemailIdleTimeout: 100 });
      const first = (await commit(detector, session, classifier))!;
      classifier.prediction(1, AMDCategory.MACHINE_VM);
      expect(await first.shouldReply(new ChatContext())).toBe(true);
      const handle = SpeechHandle.create();
      first.onAgentTurnCommitted(handle);
      const output = session.output.audio!;
      await output.captureFrame(new AudioFrame(new Int16Array(24), 24_000, 1, 24));
      output.flush();
      await output.waitForPlayout();
      handle._markDone();
      await waitFor(handle.waitForPlayout());
      speechStarted(detector);
      speechEnded(detector, 0);
      let second;
      if (reason === 'reused') {
        second = commitTurn(detector, endOfTurn(''));
      } else {
        second = (await commit(detector, session, classifier))!;
        if (reason === 'inference_error') {
          classifier.respond(2, 'not JSON');
        } else {
          classifier.prediction(2, AMDCategory.MACHINE_VM);
        }
      }
      expect(await second.shouldReply(new ChatContext())).toBe(false);
      const result = await waitFor(detector.execute());
      expect(result.reason).toBe(AMDReason.IDLE_TIMEOUT);
      expect(result.category).toBe(AMDCategory.MACHINE_VM);
    },
  );

  it('three uncertain predictions complete detection', async () => {
    const { detector, session, classifier } = await running();
    for (let turnId = 1; turnId <= 3; turnId++) {
      await commit(detector, session, classifier);
      classifier.prediction(turnId, AMDCategory.UNCERTAIN);
      await eventually(() => internals(detector).turns.get(turnId)!.prediction !== null);
    }
    expect((await detector.execute()).reason).toBe(AMDReason.MAX_UNCERTAIN_TURNS);
  });

  it.each([undefined, 1, 4])('inference timeout limit completes detection (%s)', async (limit) => {
    const expectedLimit = limit ?? 3;
    const { detector, session, classifier } = await running({
      inferenceTimeout: 10,
      ...(limit === undefined ? {} : { maxInferenceTimeouts: limit }),
    });
    for (let turnId = 1; turnId <= expectedLimit; turnId++) {
      await commit(detector, session, classifier);
      await eventually(() => internals(detector).turns.get(turnId)!.prediction !== null);
      expect(detector.lifecycle === AMDLifecycle.ACTIVE).toBe(turnId < expectedLimit);
    }
    expect((await detector.execute()).reason).toBe(AMDReason.INFERENCE_TIMEOUT);
  });

  it.each([0, -1])('max inference timeouts must be positive (%s)', (limit) => {
    expect(
      () => new AMD(new AgentSession({}), { llm: null, stt: null, maxInferenceTimeouts: limit }),
    ).toThrow('maxInferenceTimeouts must be positive');
  });

  it('supplied model is not closed by amd', async () => {
    const { detector, session, classifier } = await running();
    const aclose = vi.spyOn(classifier, 'aclose');
    await detector.aclose();
    expect(aclose).not.toHaveBeenCalled();
    expect(session.amd).toBeNull();
  });

  it.each([false, true])(
    'missing audio subscription times out and releases session (track published: %s)',
    async (trackPublished) => {
      useVirtualTime();
      const room = new FakeRoom();
      const publication = {
        sid: 'track',
        kind: TrackKind.KIND_AUDIO,
        subscribed: false,
        track: undefined,
      };
      if (trackPublished) {
        room.remoteParticipants.set('callee', fakeParticipant({ publications: [publication] }));
      }
      const { session } = await sessionWithRoom(room);
      const activity = activityOf(session);
      const started = performance.now();
      try {
        const detector = new AMD(session, {
          llm: null,
          stt: null,
          participantIdentity: 'callee',
          timeout: 100,
        });
        await detector.start();
        try {
          await eventually(() => room.listenerCount(RoomEvent.TrackSubscribed) > 0);
          expect(detector.lifecycle).toBe(AMDLifecycle.PENDING);
          expect(internals(detector).hardDeadline).toBeUndefined();
          expect(activity._authorizationPaused).toBe(true);
          // Python pushes a frame through the activity: pre-answer audio is discarded
          expect(detector._blocksSessionAudio).toBe(true);

          const pending = detector.execute();
          await vi.advanceTimersByTimeAsync(5_000);
          const result = await waitFor(pending, 6_000);
          expect(performance.now() - started).toBeGreaterThanOrEqual(5_000);
          expect(performance.now() - started).toBeLessThan(5_000 + 1_000);
          expect(result.reason).toBe(AMDReason.PARTICIPANT_MISSING);
          expect(result.category).toBe(AMDCategory.UNCERTAIN);
          expect(detector.lifecycle).toBe(AMDLifecycle.FINISHED);
          expect(session.amd).toBeNull();
          expect(session._turnHooks).toBeUndefined();
          expect(activity._authorizationPaused).toBe(false);
          expect(internals(detector).tasks.size).toBe(0);
          expect(room.eventNames()).toEqual([]);
          const [onUserStateChanged] = amdListeners(detector);
          expect(session.listeners(AgentSessionEventTypes.UserStateChanged)).not.toContain(
            onUserStateChanged,
          );
          expect(detector._blocksSessionAudio).toBe(false);
        } finally {
          await detector.aclose();
        }
      } finally {
        await closeSessionWithRoom(session);
      }
    },
  );

  describe.each(['track', 'answer'])('waiting for %s', (waitingFor) => {
    it.each([false, true])(
      'disconnect during setup reports disconnected (room disconnected: %s)',
      async (roomDisconnected) => {
        useVirtualTime();
        const room = new FakeRoom();
        const participant = fakeParticipant({
          kind: ParticipantKind.SIP,
          attributes: { 'sip.callStatus': 'ringing' },
          publications: [
            {
              sid: 'track',
              kind: TrackKind.KIND_AUDIO,
              subscribed: waitingFor === 'answer',
              track: waitingFor === 'answer' ? {} : undefined,
            },
          ],
        });
        room.remoteParticipants.set('callee', participant);
        const { session } = await sessionWithRoom(room);
        try {
          const detector = new AMD(session, {
            llm: null,
            stt: null,
            participantIdentity: 'callee',
          });
          await detector.start();
          try {
            const event =
              waitingFor === 'track'
                ? RoomEvent.TrackSubscribed
                : RoomEvent.ParticipantAttributesChanged;
            await eventually(() => room.listenerCount(event) > 0);
            const pending = detector.execute();
            if (roomDisconnected) {
              room.isConnected = false;
              room.emit(RoomEvent.Disconnected);
              // the JS track wait does not observe a room disconnect; Python's does. AMD
              // still reports it when the publication wait times out
              await vi.advanceTimersByTimeAsync(5_000);
            } else {
              room.remoteParticipants.clear();
              room.emit(RoomEvent.ParticipantDisconnected, participant);
            }
            expect((await waitFor(pending)).reason).toBe(AMDReason.PARTICIPANT_DISCONNECTED);
            expect(session.amd).toBeNull();
            expect(activityOf(session)._authorizationPaused).toBe(false);
            expect(room.eventNames()).toEqual([]);
          } finally {
            await detector.aclose();
          }
        } finally {
          await closeSessionWithRoom(session);
        }
      },
    );
  });

  it.each([true, false])(
    'sip answer gating and early media (wait until answered: %s)',
    async (waitUntilAnswered) => {
      useVirtualTime();
      const room = new FakeRoom();
      const on = vi.spyOn(room, 'on');
      const attributes: Record<string, string> = { 'sip.callStatus': 'ringing' };
      const participant = fakeParticipant({
        kind: ParticipantKind.SIP,
        attributes,
        publications: [{ sid: 'track', kind: TrackKind.KIND_AUDIO, subscribed: true, track: {} }],
      });
      room.remoteParticipants.set('callee', participant);
      const { session, setParticipant } = await sessionWithRoom(room);
      try {
        const detector = new AMD(session, {
          llm: null,
          stt: null,
          participantIdentity: 'callee',
          waitUntilAnswered,
        });
        await detector.start();
        try {
          expect(setParticipant).toHaveBeenCalledExactlyOnceWith('callee');
          if (waitUntilAnswered) {
            await eventually(() => room.listenerCount(RoomEvent.ParticipantAttributesChanged) > 0);
            await vi.advanceTimersByTimeAsync(5_100);
            expect(detector.lifecycle).toBe(AMDLifecycle.PENDING);
            expect(nextDeadline(detector)).toBeUndefined();
            attributes['sip.callStatus'] = 'active';
            room.emit(
              RoomEvent.ParticipantAttributesChanged,
              { 'sip.callStatus': 'active' },
              participant,
            );
          }
          await eventually(() => detector.lifecycle === AMDLifecycle.ACTIVE);
          if (!waitUntilAnswered) {
            expect(on).not.toHaveBeenCalledWith(
              RoomEvent.ParticipantAttributesChanged,
              expect.anything(),
            );
          }
          room.emit(RoomEvent.ParticipantDisconnected, participant);
          expect((await waitFor(detector.execute())).reason).toBe(
            AMDReason.PARTICIPANT_DISCONNECTED,
          );
          expect(detector.lifecycle).toBe(AMDLifecycle.FINISHED);
        } finally {
          await detector.aclose();
        }
      } finally {
        await closeSessionWithRoom(session);
      }
    },
  );

  it('session close completes amd and releases resources', async () => {
    const { detector, session } = await running();
    await session.close();
    expect((await detector.execute()).reason).toBe(AMDReason.CANCELLED);
    expect(session.amd).toBeNull();
    expect(internals(detector).tasks.size).toBe(0);
  });

  it('dtmf results are collected once without changing inflight requests', async () => {
    const { detector, session, classifier } = await running();
    const firstSend = dtmfExecuted(session, '12#');
    session.emit(AgentSessionEventTypes.FunctionToolsExecuted, firstSend);
    expect(classifier.requests.empty).toBe(true);
    expect(internals(detector)._state).toBe(AMDCategory.UNCERTAIN);
    expect(internals(detector)._turnId).toBe(0);

    commitTurn(detector, endOfTurn());
    const secondSend = dtmfExecuted(session, '3');
    const first = await classifier.request();
    expect(dtmfCalls(first.chatCtx)).toEqual(firstSend.functionCalls);
    commitTurn(detector, endOfTurn());
    const second = await classifier.request();
    expect(dtmfCalls(second.chatCtx)).toEqual([
      ...firstSend.functionCalls,
      ...secondSend.functionCalls,
    ]);
    expect(dtmfCalls(first.chatCtx)).toEqual(firstSend.functionCalls);
    expect(second.chatCtx.items.slice(2).map((item) => item.type)).toEqual([
      'function_call',
      'function_call_output',
      'message',
      'function_call',
      'function_call_output',
      'message',
    ]);
  });

  it('amd collects only successful dtmf calls from its run', async () => {
    const { detector, session, classifier } = await running();
    const startedAt = (detector as unknown as { startedAt: number }).startedAt;
    session.history.addMessage({ role: 'user', content: 'unrelated session transcript' });
    session.history.addMessage({ role: 'assistant', content: 'agent response' });
    dtmfExecuted(session, '1', { isError: true });
    dtmfExecuted(session, '2', { name: 'another_tool' });
    dtmfExecuted(session, '3', { createdAt: startedAt - 1 });
    const success = dtmfExecuted(session, '4');
    expect(success.hasToolReply).toBe(true);
    commitTurn(detector, endOfTurn());
    const request = await classifier.request();
    expect(dtmfCalls(request.chatCtx)).toEqual(success.functionCalls);
    expect(request.currentTurn.textContent).toBe('hello');
    expect(request.earlierTurns).toEqual([]);
    classifier.prediction(1, AMDCategory.HUMAN);
    await detector.execute();
    dtmfExecuted(session, '5');
    expect(dtmfCalls(internals(detector).chatCtx)).toEqual(success.functionCalls);
  });

  it('classifier sees that the agent spoke but not its words', async () => {
    const { detector, session, classifier } = await running();
    const startedAt = (detector as unknown as { startedAt: number }).startedAt;
    session._conversationItemAdded(
      ChatMessage.create({ role: 'assistant', content: ['before AMD'], createdAt: startedAt - 1 }),
    );
    commitTurn(detector, endOfTurn('Leave a message after the tone.'));
    await classifier.request();
    session._conversationItemAdded(ChatMessage.create({ role: 'assistant', content: [''] }));
    session._conversationItemAdded(
      ChatMessage.create({ role: 'assistant', content: ['Hi Sam, this is Alex.'] }),
    );
    commitTurn(detector, endOfTurn('To erase it and start over, press two.'));
    const request = await classifier.request();

    const history = request.chatCtx.items
      .filter((item): item is ChatMessage => item instanceof ChatMessage)
      .slice(2)
      .map((message) => [message.role, message.textContent]);
    expect(history).toEqual([
      ['user', 'Leave a message after the tone.'],
      ['assistant', AGENT_REPLY],
      ['user', 'To erase it and start over, press two.'],
    ]);
    expect((request.chatCtx.items[0] as ChatMessage).textContent).toBe(CLASSIFY_PROMPT);
  });

  it.skip('dtmf tool works without amd (waits for the #7340 ToolResult port)', () => {});

  it.skip('dtmf publish failure does not expose provider error (waits for the #7340 ToolResult port)', () => {});

  it.skip('amd observes dtmf tool completion from session (waits for the #7340 ToolResult port)', () => {});

  it.skip('dtmf tool propagates cancelled publish (waits for the #7340 ToolResult port; JS has no CancelledError)', () => {});
});
