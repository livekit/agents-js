// SPDX-FileCopyrightText: 2026 LiveKit, Inc.
//
// SPDX-License-Identifier: Apache-2.0

/** Ported from Python `tests/test_amd_models.py`: AMD model selection and resource ownership. */
import { AudioFrame } from '@livekit/rtc-node';
import { EventEmitter } from 'node:events';
import { ReadableStream } from 'node:stream/web';
import { afterEach, describe, expect, it, vi } from 'vitest';
import * as inference from '../../inference/index.js';
import { ChatContext } from '../../llm/chat_context.js';
import { FakeSTT } from '../../stt/testing/fake_stt.js';
import { Event, Task } from '../../utils.js';
import { Agent } from '../agent.js';
import type { AgentActivity } from '../agent_activity.js';
import { AgentSession } from '../agent_session.js';
import { AgentSessionEventTypes, createSpeechCreatedEvent } from '../events.js';
import { SpeechHandle } from '../speech_handle.js';
import { FakeLLM } from '../testing/fake_llm.js';
import {
  ClassifierLLM,
  DrainingSTT,
  type DrainingStream,
  commit,
  eventually,
  internals,
  pushAudio,
  running,
  waitFor,
} from './amd_test_utils.js';
import { AMD } from './detector.js';
import { AMDCategory, type AMDCompletedEvent, AMDLifecycle, AMDReason } from './events.js';

const INSTRUCTIONS = 'Call about an appointment.';
const CREDENTIAL_NAMES = [
  'LIVEKIT_API_KEY',
  'LIVEKIT_API_SECRET',
  'LIVEKIT_INFERENCE_API_KEY',
  'LIVEKIT_INFERENCE_API_SECRET',
];
const SESSION_EVENTS = [
  AgentSessionEventTypes.UserStateChanged,
  AgentSessionEventTypes.UserInputTranscribed,
  AgentSessionEventTypes.FunctionToolsExecuted,
  AgentSessionEventTypes.ConversationItemAdded,
  AgentSessionEventTypes.SpeechCreated,
  AgentSessionEventTypes.AgentStateChanged,
  AgentSessionEventTypes.AgentFalseInterruption,
];

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

function clearCredentials(): void {
  for (const name of CREDENTIAL_NAMES) {
    vi.stubEnv(name, '');
  }
}

function cloudCredentials(): void {
  clearCredentials();
  vi.stubEnv('LIVEKIT_URL', 'wss://test.livekit.cloud');
  vi.stubEnv('LIVEKIT_API_KEY', 'test-key');
  vi.stubEnv('LIVEKIT_API_SECRET', 'test-secret');
}

/** Replace the LiveKit Inference factories with test models whose close is a no-op. */
function modelFactories() {
  const model = new ClassifierLLM();
  const llmClose = vi.spyOn(model, 'aclose').mockResolvedValue();
  const stt = new DrainingSTT();
  const sttClose = vi.spyOn(stt, 'close').mockResolvedValue();
  const llmFactory = vi.spyOn(inference.LLM, 'fromModelString').mockReturnValue(model as never);
  const sttFactory = vi.spyOn(inference.STT, 'fromModelString').mockReturnValue(stt as never);
  return { model, stt, llmClose, sttClose, llmFactory, sttFactory };
}

async function startedSession(
  options: ConstructorParameters<typeof AgentSession>[0] = {},
  agent = new Agent({ instructions: INSTRUCTIONS }),
): Promise<AgentSession> {
  const session = new AgentSession({
    llm: new FakeLLM(),
    turnHandling: { turnDetection: 'manual' },
    ...options,
  });
  await session.start({ agent });
  return session;
}

function authorizationPaused(session: AgentSession): boolean {
  return (session._activity as unknown as { _authorizationPaused: boolean })._authorizationPaused;
}

function amdTranscript(detector: AMD): string {
  const stt = internals(detector).run!.stt as unknown as {
    current: { get(source: 'amd'): string };
  };
  return stt.current.get('amd');
}

function streamClosed(stream: DrainingStream): boolean {
  return (stream as unknown as { closed: boolean }).closed;
}

function sessionListenerCounts(session: AgentSession): number[] {
  return SESSION_EVENTS.map((event) => session.listenerCount(event));
}

/** Feed one frame through the activity's audio input and return what recognition receives. */
async function pushThroughActivity(activity: AgentActivity, frame: AudioFrame) {
  const recognition = (activity as unknown as { audioRecognition: object }).audioRecognition;
  let received: ReadableStream<AudioFrame> | undefined;
  vi.spyOn(
    recognition as { setInputAudioStream(stream: ReadableStream<AudioFrame>): void },
    'setInputAudioStream',
  ).mockImplementation((stream) => {
    received = stream;
  });
  activity.attachAudioInput(
    new ReadableStream<AudioFrame>({
      start(controller) {
        controller.enqueue(frame);
      },
    }),
  );
  const { value } = await waitFor(received!.getReader().read());
  return value;
}

describe('AMD model selection', () => {
  describe.each(['project', 'inference', 'mixed'])('credentials %s', (credentials) => {
    it.each([false, true])(
      'default models are auto selected and closed (finish %s)',
      async (finish) => {
        cloudCredentials();
        if (credentials !== 'project') {
          vi.stubEnv('LIVEKIT_API_KEY', '');
          vi.stubEnv('LIVEKIT_INFERENCE_API_KEY', 'test-key');
        }
        if (credentials === 'inference') {
          vi.stubEnv('LIVEKIT_API_SECRET', '');
          vi.stubEnv('LIVEKIT_INFERENCE_API_SECRET', 'test-secret');
        }
        const f = modelFactories();
        const session = await startedSession();
        try {
          const detector = new AMD(session);
          let stream: DrainingStream;
          try {
            await detector.start();
            await eventually(() => detector.lifecycle === AMDLifecycle.ACTIVE);
            expect(f.llmFactory).toHaveBeenCalledExactlyOnceWith('google/gemma-4-31b-it');
            expect(f.sttFactory).toHaveBeenCalledExactlyOnceWith('cartesia/ink-whisper');
            expect(internals(detector).llm).toBe(f.model);
            expect(internals(detector).stt).toBe(f.stt);
            stream = pushAudio(detector, f.stt);
            if (finish) {
              stream.sendFinal('hello');
              await eventually(() => amdTranscript(detector) === 'hello');
              await commit(detector, session, f.model);
              f.model.prediction(1, AMDCategory.HUMAN);
              expect((await detector.execute()).category).toBe(AMDCategory.HUMAN);
            }
          } finally {
            await detector.aclose();
          }
          expect(streamClosed(stream)).toBe(true);
          expect(f.llmClose).toHaveBeenCalledOnce();
          expect(f.sttClose).toHaveBeenCalledOnce();
          expect(session.amd).toBeNull();
          expect(authorizationPaused(session)).toBe(false);
        } finally {
          await session.close();
        }
      },
    );
  });

  it.each(['LIVEKIT_API_KEY', 'LIVEKIT_API_SECRET', 'LIVEKIT_URL'])(
    'auto selection requires cloud credentials (missing %s)',
    (missing) => {
      cloudCredentials();
      const f = modelFactories();
      vi.stubEnv(missing, '');
      const detector = new AMD(new AgentSession());
      expect(internals(detector).llm).toBeUndefined();
      expect(internals(detector).stt).toBeUndefined();
      expect(f.llmFactory).not.toHaveBeenCalled();
      expect(f.sttFactory).not.toHaveBeenCalled();
    },
  );

  it('auto selection does not use cloud models for a local server', () => {
    cloudCredentials();
    const f = modelFactories();
    vi.stubEnv('LIVEKIT_URL', 'ws://localhost:7880');
    const detector = new AMD(new AgentSession());
    expect(internals(detector).llm).toBeUndefined();
    expect(internals(detector).stt).toBeUndefined();
    expect(f.llmFactory).not.toHaveBeenCalled();
    expect(f.sttFactory).not.toHaveBeenCalled();
  });

  it('none always inherits the active agent models', async () => {
    cloudCredentials();
    const f = modelFactories();
    const model = new ClassifierLLM();
    const modelClose = vi.spyOn(model, 'aclose').mockResolvedValue();
    const session = await startedSession({}, new Agent({ instructions: INSTRUCTIONS, llm: model }));
    try {
      const detector = new AMD(session, { llm: null, stt: null });
      try {
        await detector.start();
        await eventually(() => detector.lifecycle === AMDLifecycle.ACTIVE);
        expect(internals(detector).run!.llm).toBe(model);
        expect(internals(detector).stt).toBeUndefined();
        expect((internals(detector).run!.stt as unknown as { model: unknown }).model).toBe(
          undefined,
        );
        await commit(detector, session, model);
        model.prediction(1, AMDCategory.HUMAN);
        expect((await detector.execute()).category).toBe(AMDCategory.HUMAN);
      } finally {
        await detector.aclose();
      }
      expect(modelClose).not.toHaveBeenCalled();
      expect(f.llmFactory).not.toHaveBeenCalled();
      expect(f.sttFactory).not.toHaveBeenCalled();
    } finally {
      await session.close();
    }
  });

  it.each(['llm', 'stt'])(
    'model selection is independent for each model (%s)',
    async (inherited) => {
      cloudCredentials();
      const f = modelFactories();
      const session = await startedSession();
      try {
        const detector = new AMD(session, { [inherited]: null });
        try {
          await detector.start();
          if (inherited === 'llm') {
            expect(f.llmFactory).not.toHaveBeenCalled();
            expect(f.sttFactory).toHaveBeenCalledExactlyOnceWith('cartesia/ink-whisper');
            expect(internals(detector).llm).toBeUndefined();
          } else {
            expect(f.llmFactory).toHaveBeenCalledExactlyOnceWith('google/gemma-4-31b-it');
            expect(f.sttFactory).not.toHaveBeenCalled();
            expect(internals(detector).stt).toBeUndefined();
          }
        } finally {
          await detector.aclose();
        }
      } finally {
        await session.close();
      }
    },
  );

  it.each([false, true])(
    'explicit models override auto selection (as strings %s)',
    async (asStrings) => {
      cloudCredentials();
      const f = modelFactories();
      const session = await startedSession();
      const detector = new AMD(session, {
        llm: asStrings ? 'google/gemma-4-31b-it' : f.model,
        stt: asStrings ? 'cartesia/ink-2' : f.stt,
      });
      expect(f.llmFactory).not.toHaveBeenCalled();
      expect(f.sttFactory).not.toHaveBeenCalled();
      try {
        await detector.start();
        const owned = detector as unknown as { ownsLlm: boolean; ownsStt: boolean };
        expect(internals(detector).llm).toBe(f.model);
        expect(internals(detector).stt).toBe(f.stt);
        expect(owned.ownsLlm).toBe(asStrings);
        expect(owned.ownsStt).toBe(asStrings);
        if (asStrings) {
          expect(f.llmFactory).toHaveBeenCalledExactlyOnceWith('google/gemma-4-31b-it');
          expect(f.sttFactory).toHaveBeenCalledExactlyOnceWith('cartesia/ink-2');
        } else {
          expect(f.llmFactory).not.toHaveBeenCalled();
          expect(f.sttFactory).not.toHaveBeenCalled();
        }
      } finally {
        await detector.aclose();
        await session.close();
      }
    },
  );

  it.each([null, undefined])(
    'default falls back to session model without amd credentials (stt %s)',
    async (extraStt) => {
      clearCredentials();
      const model = new ClassifierLLM();
      const session = await startedSession({ llm: model });
      try {
        const detector = new AMD(session, { stt: extraStt });
        try {
          await detector.start();
          await eventually(() => detector.lifecycle === AMDLifecycle.ACTIVE);
          expect(internals(detector).run!.llm).toBe(model);
          await commit(detector, session, model);
          model.prediction(1, AMDCategory.HUMAN);
          expect((await detector.execute()).category).toBe(AMDCategory.HUMAN);
        } finally {
          await detector.aclose();
        }
      } finally {
        await session.close();
      }
    },
  );

  describe.each([false, true])('session interruptions %s', (sessionEnabled) => {
    it.each([false, true, undefined])(
      'amd restores interruption settings (agent %s)',
      async (agentEnabled) => {
        const agent = new Agent({
          instructions: INSTRUCTIONS,
          turnHandling:
            agentEnabled === undefined ? {} : { interruption: { enabled: agentEnabled } },
        });
        const { detector, session, classifier } = await running({
          agent,
          // a first human after screening is held; Python's virtual clock then runs the idle
          // timeout to completion, so a short one keeps the same path in real time
          idleTimeout: 500,
          sessionOptions: {
            turnHandling: { turnDetection: 'manual', interruption: { enabled: sessionEnabled } },
          },
        });
        expect(session.sessionOptions.turnHandling.interruption.enabled).toBe(true);
        expect(agent._interruptionEnabled).toBe(true);
        const handles: SpeechHandle[] = [];
        session.on(AgentSessionEventTypes.SpeechCreated, (event) =>
          handles.push(event.speechHandle),
        );
        await commit(detector, session, classifier, { reply: true });
        classifier.prediction(1, AMDCategory.MACHINE_SCREENING);
        await waitFor(session._activity!._userTurnCompletedTask!.result);
        expect(handles[0]!.allowInterruptions).toBe(true);
        await waitFor(handles[0]!.waitForPlayout());

        await commit(detector, session, classifier);
        classifier.prediction(2, AMDCategory.HUMAN);
        await waitFor(detector.execute());
        expect(session.sessionOptions.turnHandling.interruption.enabled).toBe(sessionEnabled);
        expect(agent._interruptionEnabled).toBe(agentEnabled);
        const following = session.generateReply({ userInput: 'hello' });
        const expected = agentEnabled ?? sessionEnabled;
        expect(following.allowInterruptions).toBe(expected);
        await waitFor(following.waitForPlayout());
      },
    );
  });

  it('missing llm does not install turn hooks', async () => {
    const session = new AgentSession({ turnHandling: { turnDetection: 'manual' } });
    await session.start({ agent: new Agent({ instructions: INSTRUCTIONS }) });
    try {
      await expect(new AMD(session, { llm: null, stt: null }).start()).rejects.toThrow(
        'requires an LLM',
      );
      expect(session.amd).toBeNull();
      expect(session._turnHooks).toBeUndefined();
      expect(authorizationPaused(session)).toBe(false);
    } finally {
      await session.close();
    }
  });

  it.each([false, true])(
    'rejected entry does not create owned models (started %s)',
    async (started) => {
      const f = modelFactories();
      const session = new AgentSession({
        llm: new FakeLLM(),
        turnHandling: { turnDetection: 'manual' },
      });
      if (started) {
        await session.start({ agent: new Agent({ instructions: INSTRUCTIONS }) });
        // JS has no session-level IVR detection; a pending handoff also rejects entry
        session._activity!.blockNewTurns();
      }
      const detector = new AMD(session, {
        llm: 'google/gemini-3.1-flash-lite',
        stt: 'cartesia/ink-whisper',
      });
      try {
        await expect(detector.start()).rejects.toThrow();
        expect(f.llmFactory).not.toHaveBeenCalled();
        expect(f.sttFactory).not.toHaveBeenCalled();
        expect(session.amd).toBeNull();
        expect(session._turnHooks).toBeUndefined();
      } finally {
        await detector.aclose();
        await session.close();
      }
    },
  );

  it.each(['factory', 'nonstreaming'])(
    'partial model setup closes owned models (%s)',
    async (failure) => {
      const f = modelFactories();
      if (failure === 'factory') {
        f.sttFactory.mockImplementation(() => {
          throw new Error('STT setup failed');
        });
      } else {
        (f.stt as unknown as { updateCapabilities(caps: object): void }).updateCapabilities({
          streaming: false,
        });
      }
      const session = await startedSession();
      const detector = new AMD(session, {
        llm: 'google/gemini-3.1-flash-lite',
        stt: 'cartesia/ink-whisper',
      });
      try {
        await expect(detector.start()).rejects.toThrow();
        await detector.aclose();
        expect(f.llmClose).toHaveBeenCalledOnce();
        if (failure === 'nonstreaming') {
          expect(f.sttClose).toHaveBeenCalledOnce();
        } else {
          expect(f.sttClose).not.toHaveBeenCalled();
        }
        expect(session.amd).toBeNull();
        expect(session._turnHooks).toBeUndefined();
        expect(authorizationPaused(session)).toBe(false);
      } finally {
        await session.close();
      }
    },
  );

  describe.each([
    ['Error', () => new Error('setup failed')],
    ['AbortError', () => new DOMException('setup failed', 'AbortError')],
  ] as const)('%s', (_name, makeError) => {
    it.each(['pause', 'participant', 'session_on', 'room_on', 'listening'])(
      'setup failure cleans up amd (%s)',
      async (failure) => {
        const f = modelFactories();
        const agent = new Agent({
          instructions: INSTRUCTIONS,
          turnHandling: { interruption: { enabled: false } },
        });
        const session = await startedSession(
          { turnHandling: { turnDetection: 'manual', interruption: { enabled: false } } },
          agent,
        );
        const activity = session._activity!;
        const room = new EventEmitter();
        const roomIO = { rtcRoom: room, setParticipant: vi.fn() };
        session._roomIO = roomIO as never;
        const sessionListeners = sessionListenerCounts(session);
        const detector = new AMD(session, {
          llm: 'google/gemma-4-31b-it',
          stt: 'cartesia/ink-2',
          participantIdentity: 'callee',
        });
        const error = makeError();
        if (failure === 'pause') {
          const original = activity.pauseReplyAuthorization.bind(activity);
          vi.spyOn(activity, 'pauseReplyAuthorization').mockImplementation(() => {
            original();
            throw error;
          });
        } else if (failure === 'participant') {
          roomIO.setParticipant.mockImplementation(() => {
            throw error;
          });
        } else if (failure === 'session_on') {
          const original = session.on.bind(session);
          vi.spyOn(session, 'on').mockImplementation(((event: never, listener: never) => {
            const result = original(event, listener);
            if (event !== AgentSessionEventTypes.SpeechCreated) {
              return result;
            }
            throw error;
          }) as never);
        } else if (failure === 'room_on') {
          const original = room.on.bind(room);
          vi.spyOn(room, 'on').mockImplementation((event, listener) => {
            original(event, listener);
            throw error;
          });
        } else {
          const original = Task.from.bind(Task);
          vi.spyOn(Task, 'from').mockImplementation(((
            fn: never,
            controller?: AbortController,
            name?: string,
          ) => {
            if (name === 'AMD.setupListening') {
              throw error;
            }
            return original(fn, controller, name);
          }) as never);
        }
        try {
          await expect(detector.start()).rejects.toBe(error);
          expect(session.amd).toBeNull();
          expect(session._turnHooks).toBeUndefined();
          expect(authorizationPaused(session)).toBe(false);
          expect(session.sessionOptions.turnHandling.interruption.enabled).toBe(false);
          expect(agent._interruptionEnabled).toBe(false);
          expect(detector.lifecycle).toBe(AMDLifecycle.FINISHED);
          expect(internals(detector).tasks.size).toBe(0);
          vi.mocked(session.on).mockRestore?.();
          expect(sessionListenerCounts(session)).toEqual(sessionListeners);
          expect(room.listenerCount('participantDisconnected')).toBe(0);
          expect(f.llmClose).toHaveBeenCalledOnce();
          expect(f.sttClose).toHaveBeenCalledOnce();
        } finally {
          await detector.aclose();
          session._roomIO = undefined;
          await session.close();
        }
      },
    );
  });

  it('stt model string uses the standard factory and closes owned model', async () => {
    const model = new DrainingSTT();
    const close = vi.spyOn(model, 'close').mockResolvedValue();
    const factory = vi.spyOn(inference.STT, 'fromModelString').mockReturnValue(model as never);
    const { detector } = await running({ stt: 'cartesia/ink-2' });
    const stream = pushAudio(detector, model);
    expect(factory).toHaveBeenCalledExactlyOnceWith('cartesia/ink-2');
    await detector.aclose();
    expect(streamClosed(stream)).toBe(true);
    expect(close).toHaveBeenCalledOnce();
  });

  it('cleanup closes the run stream and does not close supplied stt', async () => {
    const stt = new DrainingSTT();
    const close = vi.spyOn(stt, 'close').mockResolvedValue();
    const { detector, session, classifier } = await running({ stt });
    const stream = pushAudio(detector, stt);
    stream.sendFinal('hello');
    await eventually(() => amdTranscript(detector) === 'hello');
    await commit(detector, session, classifier);
    expect(pushAudio(detector, stt)).toBe(stream);
    await new Promise((resolve) => setImmediate(resolve));
    await detector.aclose();
    expect(streamClosed(stream)).toBe(true);
    expect(stt.streams).toHaveLength(1);
    expect(internals(detector).tasks.size).toBe(0);
    expect(session.amd).toBeNull();
    expect(close).not.toHaveBeenCalled();
  });

  it('owned model cleanup failure still detaches and releases turn hooks', async () => {
    const stt = new DrainingSTT();
    vi.spyOn(stt, 'close').mockRejectedValue(new Error('close failed'));
    vi.spyOn(inference.STT, 'fromModelString').mockReturnValue(stt as never);
    const { detector, session, classifier } = await running({ stt: 'cartesia/ink-2' });
    const stream = pushAudio(detector, stt);
    stream.sendFinal('hello');
    await eventually(() => amdTranscript(detector) === 'hello');
    await commit(detector, session, classifier);
    await waitFor(detector.aclose());
    expect((await detector.execute()).reason).toBe(AMDReason.CANCELLED);
    expect(session.amd).toBeNull();
    expect(authorizationPaused(session)).toBe(false);
  });

  it.each([AMDCategory.HUMAN, AMDCategory.MACHINE_UNAVAILABLE])(
    'finish detaches before task cleanup and preserves a new run (%s)',
    async (category) => {
      const { detector, session, classifier } = await running();
      const activity = session._activity!;
      const started = new Event();
      const cancelling = new Event();
      const release = new Event();
      (detector as unknown as { spawn(fn: (signal: AbortSignal) => Promise<void>): void }).spawn(
        async (signal) => {
          started.set();
          await new Promise((resolve) => signal.addEventListener('abort', resolve));
          cancelling.set();
          await release.wait();
        },
      );
      await started.wait();
      const terminalSessionState: unknown[] = [];
      detector.on('amd_prediction', () =>
        terminalSessionState.push([session.amd, session._turnHooks, authorizationPaused(session)]),
      );
      try {
        await commit(detector, session, classifier);
        classifier.prediction(1, category);
        await waitFor(cancelling.wait());
        expect(terminalSessionState).toEqual([[null, undefined, false]]);
        expect(session.currentAgent._interruptionEnabled).toBeUndefined();
        const run = internals(detector).run as unknown as { completion: { done: boolean } };
        expect(run.completion.done).toBe(false);

        const amdAudio = vi.spyOn(detector, 'pushAudio');
        const frame = new AudioFrame(new Int16Array(320).fill(7), 16_000, 1, 320);
        const received = await pushThroughActivity(activity, frame);
        expect(received).toBe(frame);
        expect(amdAudio).not.toHaveBeenCalled();

        const following = new AMD(session, { llm: new ClassifierLLM(), stt: null });
        (
          following as unknown as { setupListening(signal: AbortSignal): Promise<void> }
        ).setupListening = (signal) =>
          new Promise((resolve) => signal.addEventListener('abort', () => resolve()));
        await following.start();
        try {
          expect(following.lifecycle).toBe(AMDLifecycle.PENDING);
          const cancelPending = vi.spyOn(activity, '_cancelPendingSpeeches');
          const cancelPreemptive = vi.spyOn(activity, '_cancelPreemptiveGeneration');
          release.set();
          expect((await waitFor(detector.execute())).category).toBe(category);
          expect(session.amd).toBe(following);
          expect(session._turnHooks).toBe(
            (following as unknown as { turnHooks: unknown }).turnHooks,
          );
          expect(authorizationPaused(session)).toBe(true);
          expect(session.currentAgent._interruptionEnabled).toBe(true);
          expect(cancelPending).not.toHaveBeenCalled();
          expect(cancelPreemptive).not.toHaveBeenCalled();
        } finally {
          await following.aclose();
        }
        expect(session.currentAgent._interruptionEnabled).toBeUndefined();
      } finally {
        release.set();
      }
    },
  );

  describe.each(['run_stt', 'owned_stt', 'owned_llm'])('close target %s', (closeTarget) => {
    it.each([AMDCategory.HUMAN, AMDCategory.MACHINE_UNAVAILABLE])(
      'slow resource close does not keep amd attached (%s)',
      async (category) => {
        const f = modelFactories();
        const classifier = f.model;
        const session = await startedSession();
        try {
          const detector = new AMD(session, {
            llm: 'google/gemma-4-31b-it',
            stt: 'cartesia/ink-2',
            machineSilenceThreshold: 0,
          });
          const sessionListeners = sessionListenerCounts(session);
          try {
            await detector.start();
            await eventually(() => detector.lifecycle === AMDLifecycle.ACTIVE);
            const stream = pushAudio(detector, f.stt);
            const [target, method] = {
              run_stt: [internals(detector).run!.stt, 'aclose'],
              owned_stt: [f.stt, 'close'],
              owned_llm: [classifier, 'aclose'],
            }[closeTarget] as [Record<string, () => Promise<void>>, string];
            const closeStarted = new Event();
            const releaseClose = new Event();
            const originalClose = target[method]!.bind(target);

            stream.sendFinal('hello');
            await eventually(() => amdTranscript(detector) === 'hello');
            const hooks = (await commit(detector, session, classifier))!;
            classifier.prediction(1, AMDCategory.MACHINE_VM);
            expect(await hooks.shouldReply(new ChatContext())).toBe(true);
            const speech = SpeechHandle.create();
            session.emit(
              AgentSessionEventTypes.SpeechCreated,
              createSpeechCreatedEvent({
                speechHandle: speech,
                userInitiated: false,
                source: 'generate_reply',
              }),
            );
            hooks.onAgentTurnCommitted(speech);
            const removeCallback = vi.spyOn(speech, 'removeDoneCallback');
            const activity = session._activity!;
            const cancelPending = vi.spyOn(activity, '_cancelPendingSpeeches');
            const cancelPreemptive = vi.spyOn(activity, '_cancelPreemptiveGeneration');
            const completedEvents: AMDCompletedEvent[] = [];
            detector.on('amd_completed', (event) => completedEvents.push(event));
            let completionDone = false;
            const completion = detector.execute().then((result) => {
              completionDone = true;
              return result;
            });
            let result: AMDCompletedEvent;
            try {
              target[method] = async () => {
                closeStarted.set();
                await releaseClose.wait();
                await originalClose();
              };
              stream.sendFinal('hello');
              await eventually(() => amdTranscript(detector) === 'hello');
              await commit(detector, session, classifier);
              classifier.prediction(2, category);
              await waitFor(closeStarted.wait());

              expect(session.amd).toBeNull();
              expect(session._turnHooks).toBeUndefined();
              expect(authorizationPaused(session)).toBe(false);
              expect(sessionListenerCounts(session)).toEqual(sessionListeners);
              const handlers = detector as unknown as {
                onSpeechDone: unknown;
                onVoicemailDone: unknown;
              };
              expect(removeCallback).toHaveBeenCalledWith(handlers.onSpeechDone);
              expect(removeCallback).toHaveBeenCalledWith(handlers.onVoicemailDone);
              expect(cancelPending.mock.calls.length > 0).toBe(
                category === AMDCategory.MACHINE_UNAVAILABLE,
              );
              expect(cancelPreemptive).toHaveBeenCalled();
              expect(completionDone).toBe(false);
              expect(completedEvents).toEqual([]);
            } finally {
              releaseClose.set();
              result = await waitFor(completion);
              speech._markDone();
            }
            expect(result.category).toBe(category);
            expect(result.reason).toBe(AMDReason.FINISHED);
            expect(completedEvents).toEqual([result]);
          } finally {
            await detector.aclose();
          }
        } finally {
          await session.close();
        }
      },
    );
  });

  it('nonstreaming stt is rejected', () => {
    const stt = new FakeSTT();
    (stt as unknown as { updateCapabilities(caps: object): void }).updateCapabilities({
      streaming: false,
    });
    expect(() => new AMD(new AgentSession(), { llm: null, stt })).toThrow('streaming STT');
  });
});
